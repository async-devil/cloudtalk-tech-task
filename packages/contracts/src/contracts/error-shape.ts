import { ERROR_CODES } from '@repo/kernel';
import { z } from 'zod';

/**
 * The uniform wire error shape (ADR-0008 defines the taxonomy, ADR-0004 the boundary that renders it): `code` is one of the kernel `ErrorCode`
 * values; `message` is safe-for-wire (5xx bodies replace it with a generic string at the HTTP
 * boundary); `details` is optional structured, safe-for-wire context.
 *
 * `code` derives from `@repo/kernel`'s `ERROR_CODES` (ADR-0003: one source of truth) — the wire shape can no longer
 * drift from the taxonomy, and the dependency direction (contracts -> kernel) is already allowed.
 */
export const apiErrorShape = z.object({
  code: z.enum(ERROR_CODES),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type ApiErrorShape = z.infer<typeof apiErrorShape>;
