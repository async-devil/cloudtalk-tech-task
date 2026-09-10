// RED: passes a string where the module declares a number. `tsc --noEmit` on the package's own
// tsconfig never sees this file (`include: ["src"]`), and vitest would transpile it happily — this
// gate is the only thing in the chain that reports it.
import { widgetName } from '../src/index.js';

const name: string = widgetName('not-a-number');
export { name };
