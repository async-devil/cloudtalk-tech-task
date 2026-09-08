import { z } from 'zod';

/** The payload shape for every scheduled pass this package wires (outbox relay, reconciler,
 * retention, `startOutboxRelay`/`startReconciler`/`startRetention`): a repeatable tick carries no
 * data of its own — `scheduleRepeatable` always registers it with `data: {}`. */
export const tickSchema = z.object({}).strict();
export type Tick = z.infer<typeof tickSchema>;
