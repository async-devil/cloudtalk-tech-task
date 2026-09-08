import { defineConfigSlice, isFailClosed } from '@repo/config';
import { z } from 'zod';

/**
 * The persistence config slice (ADR-0002):
 *
 * | env key | required | default (test) |
 * |---|---|---|
 * | `DATABASE_URL` | always | — |
 * | `DATABASE_OWNER_URL` | fail-closed tiers (migrate task, ADR-0003) | falls back to `DATABASE_URL` |
 * | `DATABASE_POOL_SIZE` | no | `10` |
 */
export const configSlice = defineConfigSlice('persistence', (mode) =>
  z
    .object({
      DATABASE_URL: z
        .string()
        .min(1)
        .describe(
          'Required. Runtime connection string; dev value targets the compose postgres ' +
            '(postgres://postgres:dev@localhost:5432/reviews).',
        ),
      DATABASE_OWNER_URL: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Live-required. Distinct owner connection for `moon run api:migrate` (ADR-0006); ' +
            'falls back to DATABASE_URL in non-live modes.',
        ),
      DATABASE_POOL_SIZE: z.coerce
        .number()
        .int()
        .min(1)
        .default(10)
        .describe('Max pooled connections.'),
    })
    .superRefine((value, ctx) => {
      if (isFailClosed(mode) && value.DATABASE_OWNER_URL === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['DATABASE_OWNER_URL'],
          message:
            'DATABASE_OWNER_URL is required in staging/production (distinct owner connection for the migrate task — ADR-0011)',
        });
      }
    })
    .transform((value) => ({
      ...value,
      DATABASE_OWNER_URL: value.DATABASE_OWNER_URL ?? value.DATABASE_URL,
    })),
);

/** The parsed output of {@link configSlice} (ADR-0002): the app composes its config shape
 * from this exported type rather than restating the field list by hand. Reflects the post-transform
 * shape (`DATABASE_OWNER_URL` always present). */
export type PersistenceSliceConfig = z.infer<ReturnType<typeof configSlice.schema>>;
