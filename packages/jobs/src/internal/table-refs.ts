import type { PipelineTableContract } from '../contract.js';

/** `{schema}.{table}` — the pipeline instance table. Passed to `sql.table`, which
 * splits on `.` into a schema-qualified identifier; safe because every segment was already
 * validated by {@link import('../contract.js').createPipelineTableContract}. */
export function instanceTableRef(contract: PipelineTableContract): string {
  return `${contract.schema}.${contract.table}`;
}

/** `{schema}.{table}_stage_result` — the write-ahead sibling table. */
export function stageResultTableRef(contract: PipelineTableContract): string {
  return `${contract.schema}.${contract.table}_stage_result`;
}

/** `{schema}.{table}_branch` — the fan-out/join sibling table. */
export function branchTableRef(contract: PipelineTableContract): string {
  return `${contract.schema}.${contract.table}_branch`;
}
