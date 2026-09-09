// Deliberate violation: SDK import outside apps/*/src/runtime/** and outside the owning module
// (ADR-0005). 'jobs' does not own bullmq -- 'messaging' does.
import { Queue } from 'bullmq';

export { Queue };
