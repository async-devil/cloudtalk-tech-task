import { z } from 'zod';

/** The `auth.app_user` shape the session middleware reads. Raw SQL rows parse through `rowAs` at
 * this boundary rather than being cast (ADR-0004, ADR-0006) — a cast is a claim, a parse is a
 * check. Only the two columns that path actually needs. */
export const appUserRowSchema = z.object({
  app_user_id: z.string(),
  token: z.string(),
});
export type AppUserRow = z.infer<typeof appUserRowSchema>;
