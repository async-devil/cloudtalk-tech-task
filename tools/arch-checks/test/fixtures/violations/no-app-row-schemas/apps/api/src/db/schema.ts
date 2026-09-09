// Deliberate violation: an app declaring its own row schema instead of importing the storage
// shape from @repo/entities through @repo/persistence (ADR-0011). A zod import under an app's
// db/ folder is the structural proxy for that restatement.
import { z } from 'zod';

export const rowSchema = z.object({ id: z.string() });
