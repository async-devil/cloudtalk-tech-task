import { ValidationError } from '@repo/kernel';
import { assertIdentifier, assertIdentifierByteLength } from './internal/identifiers.js';

/**
 * The pipeline state-table contract (ADR-0007: the caller owns the table, the helpers are
 * generic). One pipeline instance is one row in a
 * module-owned table, in that module's own schema (ADR-0011) — the generic helpers in this
 * package never own the table, they demand this shape.
 */
export interface PipelineTableContract {
  /** Span/jobId segment (ADR-0009 `jobs.{pipeline}.{stage}`), `^[a-z][a-z0-9_]*$`. */
  readonly pipeline: string;
  /** The owning module's schema (ADR-0011), e.g. `'example_context'`. Every table this
   * contract addresses — instance, stage-result, branch — lives in it. */
  readonly schema: string;
  /** The instance table, singular and unprefixed, e.g. `'item'` (ADR-0011: the schema
   * carries the context, so the table name must not). Also prefixes the sibling tables:
   * `{table}_stage_result`, `{table}_branch`. */
  readonly table: string;
  /** `<table>_id` per ADR-0011, e.g. `'item_id'`. */
  readonly instanceIdColumn: string;
  readonly stages: ReadonlyArray<string>;
}

/**
 * Validates every identifier against `^[a-z][a-z0-9_]*$` (throws {@link ValidationError}) — the
 * ONLY gate between contract strings and SQL interpolation via `sql.id`/`sql.table` anywhere in
 * this package. Also validates `instanceIdColumn === \`${table}_id\`` (ADR-0011) and that
 * every derived identifier this spec generates — the table names, and the
 * `fk_{table}__stage_status__{stage}` constraint names, which are the longest — fits
 * PostgreSQL's 63-byte limit (ADR-0011: it truncates silently, so the contract refuses rather
 * than let the engine collide two names months later).
 */
export function createPipelineTableContract(
  contract: PipelineTableContract,
): PipelineTableContract {
  assertIdentifier(contract.pipeline, 'PipelineTableContract.pipeline');
  assertIdentifier(contract.schema, 'PipelineTableContract.schema');
  assertIdentifier(contract.table, 'PipelineTableContract.table');
  assertIdentifier(contract.instanceIdColumn, 'PipelineTableContract.instanceIdColumn');

  if (contract.stages.length === 0) {
    throw new ValidationError('PipelineTableContract.stages must declare at least one stage');
  }
  for (const stage of contract.stages) {
    assertIdentifier(stage, `PipelineTableContract.stages entry "${stage}"`);
  }

  const expectedInstanceIdColumn = `${contract.table}_id`;
  if (contract.instanceIdColumn !== expectedInstanceIdColumn) {
    throw new ValidationError(
      `PipelineTableContract.instanceIdColumn must be "${expectedInstanceIdColumn}" (ADR-0011: <table>_id), got "${contract.instanceIdColumn}"`,
    );
  }

  assertIdentifierByteLength(contract.table, 'instance table name');
  assertIdentifierByteLength(`${contract.table}_stage_result`, 'stage-result table name');
  assertIdentifierByteLength(`${contract.table}_branch`, 'branch table name');
  for (const stage of contract.stages) {
    assertIdentifierByteLength(
      `fk_${contract.table}__stage_status__${stage}`,
      `stage-status FK constraint name for stage "${stage}"`,
    );
  }

  return {
    pipeline: contract.pipeline,
    schema: contract.schema,
    table: contract.table,
    instanceIdColumn: contract.instanceIdColumn,
    stages: [...contract.stages],
  };
}
