import { NotFoundError } from '@repo/kernel';
import { rowAs } from '@repo/persistence';
import { type Kysely, sql } from 'kysely';
import { productIdRowSchema } from './rows.js';

/**
 * Resolves a product's internal `product_id` from its public `slug` (ADR-0016: `slug` is the only
 * address a caller ever supplies) — the one place this module turns the wire-facing address into
 * the id every write below it needs. `product_id` never escapes this function's caller as part of
 * an exported record (ADR-0016: no internal uuid crosses this module's public contract).
 * @throws NotFoundError when no product has this slug.
 */
export async function resolveProductId(db: Kysely<unknown>, productSlug: string): Promise<string> {
  const result = await sql`
    SELECT product_id FROM reviews.product WHERE slug = ${productSlug}
  `.execute(db);
  const row = result.rows[0];
  if (row === undefined) {
    throw new NotFoundError(`no product with slug "${productSlug}"`);
  }
  return rowAs(productIdRowSchema, row).product_id;
}
