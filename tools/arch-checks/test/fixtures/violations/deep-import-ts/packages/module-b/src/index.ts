// Deliberate violation, TypeScript flavor: guards that .ts sources are actually PARSED by
// dependency-cruiser (via @swc/core — typescript@7 is outside 18.1.0's supported range). If TS
// parsing ever silently breaks, this fixture stops firing and the selftest goes red.
import { secret } from '../../module-a/src/internal/secret.js';

export { secret };
