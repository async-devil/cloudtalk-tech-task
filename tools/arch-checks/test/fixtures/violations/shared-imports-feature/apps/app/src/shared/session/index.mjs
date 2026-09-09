// Deliberate violation (ADR-0012): `shared/` is the app kernel — it must never import a feature,
// or deleting that feature stops being a local operation and the "delete a folder" isolation
// property is dead.
export { checkoutState } from '../../features/checkout/index.mjs';
