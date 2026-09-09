import { defineConfigSlice } from '@repo/config';
import { z } from 'zod';

/**
 * The messaging config slice (ADR-0005; keys frozen in):
 *
 * | env key | required | default (non-live) |
 * |---|---|---|
 * | `REDIS_URL` | always | — |
 */
export const configSlice = defineConfigSlice('messaging', () =>
  z.object({
    REDIS_URL: z
      .string()
      .min(1)
      .describe('Required. Dev value targets the compose redis (redis://localhost:6379).'),
  }),
);

/** The parsed output of {@link configSlice} (ADR-0003a): the app composes its config shape
 * from this exported type rather than restating the field list by hand. */
export type MessagingSliceConfig = z.infer<ReturnType<typeof configSlice.schema>>;
