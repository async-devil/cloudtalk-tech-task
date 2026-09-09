// Deliberate violation: reaches into module-a's internal/ instead of importing its barrel.
import { secret } from '../../module-a/src/internal/secret.mjs';

export { secret };
