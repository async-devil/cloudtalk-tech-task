// Deliberate violation: a.mjs <-> b.mjs form a cycle.
export { b } from './b.mjs';
export const a = 1;
