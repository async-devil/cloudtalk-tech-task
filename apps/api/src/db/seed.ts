/**
 * The `moon run api:seed` entry point (TASK-0006, ADR-0005): populates a realistic catalogue on
 * top of already-migrated schema. A thin CLI wrapper, the same shape `migrate.ts` already
 * establishes: compose the persistence config slice, open a `db` handle, do the work, report.
 *
 * IDEMPOTENT BY DESIGN, not by a truncate-and-reinsert shortcut:
 *   - Accounts are matched by email (`auth.identity.email` is already unique) — an existing
 *     account has its capability flags brought up to what this script wants, never duplicated.
 *   - Products are matched by slug (TASK-0006's own acceptance criterion) — `createProduct`
 *     is not itself idempotent (a second call would hit the unique constraint), so this script
 *     checks first and only creates what is missing.
 *   - Reviews go through `submitReview`, which is ALREADY idempotent by natural key
 *     (`product_id`, `author_id`) — TASK-0002's own replay guarantee. Calling it twice with the
 *     same content is a no-op, which is exactly what running this script twice needs.
 *   - Moderation and rating rebuilds go through `setReviewModerationState`/`rebuildProductRating`,
 *     both already idempotent (TASK-0009's no-op branch; TASK-0002's rebuild-is-idempotent
 *     criterion) — calling either again on an already-settled row changes nothing.
 *
 * `auth.identity`/`auth.app_user` are written directly with raw SQL rather than through
 * better-auth's own sign-up flow: this script runs offline, before any HTTP server exists to
 * sign up against, and TASK-0006 asks for a fully-formed account (with `catalogue_manager`/
 * `moderator` already granted) rather than the empty one a real sign-up produces. This is
 * composition-root tooling, the same tier `migrate.ts` occupies — not a `@repo/reviews` or
 * `@repo/auth` module boundary crossing, since neither module is imported to do it.
 */

import process from 'node:process';
import {
  APP_MODE,
  ConfigError,
  type ConfigSource,
  composeConfig,
  envFileSource,
  processEnvSource,
  readAppMode,
} from '@repo/config';
// New dependency for this composition-root script only: minting a seeded account's public token
// the same way the real session-create hook would, without pulling in the hook itself.
import { mintToken, TOKEN_PREFIX } from '@repo/entities';
import {
  createDb,
  type PersistenceSliceConfig,
  configSlice as persistenceConfigSlice,
} from '@repo/persistence';
import {
  createProduct,
  rebuildProductRating,
  setReviewModerationState,
  submitReview,
} from '@repo/reviews';
import { type Kysely, sql } from 'kysely';

interface SeedConfig {
  readonly persistence: PersistenceSliceConfig;
}

interface SeedAccountInput {
  readonly email: string;
  readonly name: string;
  readonly catalogueManager?: boolean;
  readonly moderator?: boolean;
}

/** Creates or updates one `auth.identity` + `auth.app_user` pair, matched by email — idempotent:
 * an existing row's capability flags are brought up to what this call asks for (never revoked, so
 * re-running the seed after a manual capability grant elsewhere never takes one away). */
async function ensureAccount(db: Kysely<unknown>, input: SeedAccountInput): Promise<string> {
  const identityResult = await sql`
    INSERT INTO auth.identity (name, email, email_verified)
    VALUES (${input.name}, ${input.email}, true)
    ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
    RETURNING id
  `.execute(db);
  const identityId = (identityResult.rows[0] as { readonly id: string }).id;

  const appUserResult = await sql`
    INSERT INTO auth.app_user (identity_id, token, catalogue_manager, moderator)
    VALUES (${identityId}, ${mintToken(TOKEN_PREFIX.User)}, ${input.catalogueManager ?? false}, ${input.moderator ?? false})
    ON CONFLICT (identity_id) DO UPDATE SET
      catalogue_manager = auth.app_user.catalogue_manager OR EXCLUDED.catalogue_manager,
      moderator = auth.app_user.moderator OR EXCLUDED.moderator
    RETURNING app_user_id
  `.execute(db);
  return (appUserResult.rows[0] as { readonly app_user_id: string }).app_user_id;
}

interface SeedProductInput {
  readonly slug: string;
  readonly sku: string;
  readonly name: string;
  readonly description: string;
  readonly categoryName: string;
  readonly priceMinor: number;
}

/** Creates a product only if no row already has this slug (TASK-0006: "products are matched by
 * slug") — `createProduct` itself is not idempotent, so the check happens here. */
async function ensureProduct(db: Kysely<unknown>, input: SeedProductInput): Promise<void> {
  const existing = await sql`SELECT 1 FROM reviews.product WHERE slug = ${input.slug}`.execute(db);
  if (existing.rows.length > 0) {
    return;
  }
  await createProduct(db, {
    slug: input.slug,
    sku: input.sku,
    name: input.name,
    description: input.description,
    categoryName: input.categoryName,
    priceMinor: input.priceMinor,
    currencyCode: 'USD',
  });
}

/** Backdates a review's `created_at` for realistic, non-simultaneous submission dates —
 * `submitReview` has no such parameter (a real submission is always "now"), and this script is
 * the one legitimate place to reach past it: seed data whose every review shares one timestamp
 * would make "newest first" and "rated N ago" both look wrong on a freshly-seeded catalogue.
 * Idempotent by construction: setting the same date twice changes nothing. */
async function backdateReview(
  db: Kysely<unknown>,
  reviewToken: string,
  daysAgo: number,
): Promise<void> {
  await sql`
    UPDATE reviews.review
    SET created_at = now() - (${daysAgo} || ' days')::interval,
        updated_at = now() - (${daysAgo} || ' days')::interval
    WHERE token = ${reviewToken}
  `.execute(db);
}

const PRODUCTS: readonly SeedProductInput[] = [
  {
    slug: 'sony-wh-1000xm5',
    sku: 'AUD-WH1000XM5',
    name: 'Sony WH-1000XM5',
    description: 'Noise-cancelling over-ear headphones with 30-hour battery life.',
    categoryName: 'audio',
    priceMinor: 34_999,
  },
  {
    slug: 'jbl-flip-6',
    sku: 'AUD-JBLFLIP6',
    name: 'JBL Flip 6',
    description: 'A waterproof portable Bluetooth speaker built for one to a room.',
    categoryName: 'audio',
    priceMinor: 12_999,
  },
  {
    slug: 'framework-laptop-13',
    sku: 'CMP-FWLAP13',
    name: 'Framework Laptop 13',
    description: 'A repairable, upgradeable 13-inch laptop with swappable ports.',
    categoryName: 'computing',
    priceMinor: 119_900,
  },
  {
    slug: 'logitech-mx-master-3s',
    sku: 'CMP-MXM3S',
    name: 'Logitech MX Master 3S',
    description: 'A quiet-click ergonomic mouse for all-day desk work.',
    categoryName: 'computing',
    priceMinor: 9_999,
  },
  {
    slug: 'dyson-v15-detect',
    sku: 'HOM-DYV15',
    name: 'Dyson V15 Detect',
    description: 'A cordless vacuum with a laser that reveals the dust you missed.',
    categoryName: 'home',
    priceMinor: 74_999,
  },
  {
    slug: 'nemo-dagger-osmo-2p',
    sku: 'OUT-NEMODAG2P',
    name: 'Nemo Dagger Osmo 2P',
    description: 'A two-person backpacking tent with a freestanding double-wall design.',
    categoryName: 'outdoor',
    priceMinor: 54_999,
  },
  {
    slug: 'le-creuset-dutch-oven',
    sku: 'KIT-LCDUTCH',
    name: 'Le Creuset Dutch Oven',
    description: 'An enamelled cast-iron pot that outlives whoever buys it.',
    categoryName: 'kitchen',
    priceMinor: 39_999,
  },
  // Deliberately unreviewed (TASK-0004's "No reviews yet" rendering, rule 14) — every other
  // product below gets at least one review, so this is the one product a fresh catalogue browse
  // shows in the honestly-unrated state.
  {
    slug: 'baratza-encore-grinder',
    sku: 'KIT-BARENC',
    name: 'Baratza Encore Conical Burr Grinder',
    description: 'An entry-level burr grinder that outperforms every blade grinder at its price.',
    categoryName: 'kitchen',
    priceMinor: 16_999,
  },
];

async function main(): Promise<void> {
  const mode = readAppMode(process.env);
  const sources: ConfigSource[] = [
    ...(mode === APP_MODE.Test ? [envFileSource('.env')] : []),
    processEnvSource(process.env),
  ];
  const { config } = await composeConfig<SeedConfig>({
    mode,
    slices: [persistenceConfigSlice],
    sources,
  });

  const db = createDb<unknown>({ connectionString: config.persistence.DATABASE_URL });

  try {
    // Accounts. Five: the two capability holders TASK-0006 requires, and three plain reviewers
    // whose reviews give the catalogue its spread of ratings and dates.
    await ensureAccount(db, {
      email: 'manager@example.test',
      name: 'Casey the Catalogue Manager',
      catalogueManager: true,
    });
    await ensureAccount(db, {
      email: 'moderator@example.test',
      name: 'Morgan the Moderator',
      moderator: true,
    });
    const reviewerA = await ensureAccount(db, {
      email: 'reviewer.a@example.test',
      name: 'Alex Rivera',
    });
    const reviewerB = await ensureAccount(db, {
      email: 'reviewer.b@example.test',
      name: 'Blair Chen',
    });
    const reviewerC = await ensureAccount(db, {
      email: 'reviewer.c@example.test',
      name: 'Casey Nguyen',
    });
    process.stdout.write('seed: accounts ensured (manager, moderator, 3 reviewers)\n');

    // Products, matched by slug.
    for (const product of PRODUCTS) {
      await ensureProduct(db, product);
    }
    process.stdout.write(`seed: ${PRODUCTS.length} products ensured\n`);

    // Reviews: a deliberately NON-uniform spread of ratings and dates, concentrated on one
    // product (`sony-wh-1000xm5`) so its aggregate is not trivially equal to a single rating
    // (TASK-0006's own criterion), and varied enough elsewhere that "Highest rated" sorts
    // visibly differently from "Most recent".
    const reviewSeeds: ReadonlyArray<{
      readonly productSlug: string;
      readonly authorId: string;
      readonly rating: number;
      readonly title: string;
      readonly body: string;
      readonly daysAgo: number;
    }> = [
      {
        productSlug: 'sony-wh-1000xm5',
        authorId: reviewerA,
        rating: 5,
        title: 'Best noise cancelling I have owned',
        body: 'The ANC on these is genuinely a different tier from anything I tried before buying.',
        daysAgo: 40,
      },
      {
        productSlug: 'sony-wh-1000xm5',
        authorId: reviewerB,
        rating: 4,
        title: 'Great sound, a bit tight after hours',
        body: 'Audio quality is excellent, but the clamping force gets noticeable on long flights.',
        daysAgo: 21,
      },
      {
        productSlug: 'sony-wh-1000xm5',
        authorId: reviewerC,
        rating: 2,
        title: 'Mine arrived with a firmware bug',
        body: 'Bluetooth kept dropping until a firmware update fixed it a week later.',
        daysAgo: 9,
      },
      {
        productSlug: 'jbl-flip-6',
        authorId: reviewerA,
        rating: 4,
        title: 'Does exactly what it promises',
        body: 'Loud enough for a backyard, survived a drop in the pool by accident.',
        daysAgo: 14,
      },
      {
        productSlug: 'framework-laptop-13',
        authorId: reviewerB,
        rating: 5,
        title: 'Finally a laptop I can actually repair',
        body: 'Swapped the battery myself in ten minutes with no special tools.',
        daysAgo: 60,
      },
      {
        productSlug: 'logitech-mx-master-3s',
        authorId: reviewerC,
        rating: 3,
        title: 'Comfortable but the app is clunky',
        body: 'The mouse itself is great; Logi Options+ crashes more than I would like.',
        daysAgo: 5,
      },
      {
        productSlug: 'dyson-v15-detect',
        authorId: reviewerA,
        rating: 5,
        title: 'The laser gimmick is actually useful',
        body: 'Found dust on the baseboards I would have sworn were clean.',
        daysAgo: 30,
      },
      {
        productSlug: 'nemo-dagger-osmo-2p',
        authorId: reviewerB,
        rating: 1,
        title: 'A seam failed on its second trip',
        // This one is seeded as the `rejected` review (TASK-0006's own criterion) — see below.
        body: 'Not what I expected for the price, and support was slow to respond.',
        daysAgo: 3,
      },
      {
        productSlug: 'le-creuset-dutch-oven',
        authorId: reviewerC,
        rating: 5,
        title: 'Worth every cent, will outlive me',
        body: 'Evenly heated everything I have cooked in it so far, zero complaints.',
        daysAgo: 75,
      },
    ];

    const reviewTokens = new Map<string, string>();
    for (const seed of reviewSeeds) {
      const result = await submitReview(db, {
        productSlug: seed.productSlug,
        authorId: seed.authorId,
        rating: seed.rating,
        title: seed.title,
        body: seed.body,
      });
      reviewTokens.set(seed.title, result.review.token);
      await backdateReview(db, result.review.token, seed.daysAgo);
    }
    process.stdout.write(`seed: ${reviewSeeds.length} reviews submitted\n`);

    // Exactly one seeded review left `rejected` (TASK-0006's own criterion), so the moderation
    // screen's `rejected` filter has something to show immediately after setup.
    const rejectedToken = reviewTokens.get('A seam failed on its second trip');
    if (rejectedToken !== undefined) {
      await setReviewModerationState(db, { reviewToken: rejectedToken, targetState: 'rejected' });
      process.stdout.write('seed: one review left in the rejected state\n');
    }

    // Recompute every seeded product's rating projection (ADR-0014: the projection is rebuilt,
    // never written directly, even by this script) — an unreviewed product like the grinder
    // above has no row to rebuild and correctly stays "No reviews yet".
    const reviewedSlugs = [...new Set(reviewSeeds.map((seed) => seed.productSlug))];
    for (const productSlug of reviewedSlugs) {
      await rebuildProductRating(db, { productSlug });
    }
    process.stdout.write(`seed: rating projection rebuilt for ${reviewedSlugs.length} products\n`);

    process.stdout.write('seed: done\n');
  } finally {
    await db.destroy();
  }
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    for (const issue of error.issues) {
      process.stderr.write(`seed: config: ${issue.key}: ${issue.message}\n`);
    }
  } else {
    process.stderr.write(`seed: ${String(error)}\n`);
  }
  process.exit(1);
});
