/**
 * Deterministic job id (named invariant): `` `${stage}_${entityId}` ``. Deduplicates
 * via BullMQ's own `jobId` mechanism — re-enqueuing the same entity for the same stage while a
 * job is still active/waiting is a no-op at the BullMQ layer.
 */
export function jobIdFor(stage: string, entityId: string): string {
  return `${stage}_${entityId}`;
}
