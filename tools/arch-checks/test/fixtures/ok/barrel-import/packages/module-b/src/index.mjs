// OK: bare specifier with no subpath is barrel-only access (unresolvable in this isolated
// fixture -- no real node_modules linking -- but that is exactly the point: the "to" path never
// matches the forbidden deep-import forms, resolvable or not).
import { secret } from '@repo/module-a';

export { secret };
