import { ValidationError } from '@repo/kernel';
import { describe, expect, it } from 'vitest';
import { createPipelineTableContract, type PipelineTableContract } from '../src/contract.js';

const VALID: PipelineTableContract = {
  pipeline: 'example',
  schema: 'example_context',
  table: 'item',
  instanceIdColumn: 'item_id',
  stages: ['enrich', 'distribute'],
};

describe('createPipelineTableContract (ADR-0011)', () => {
  it('accepts a valid contract and returns an equivalent (defensively copied) object', () => {
    const contract = createPipelineTableContract(VALID);
    expect(contract).toStrictEqual(VALID);
    expect(contract.stages).not.toBe(VALID.stages);
  });

  it.each([
    ['pipeline', { ...VALID, pipeline: 'Example' }],
    ['pipeline', { ...VALID, pipeline: 'example-context' }],
    ['schema', { ...VALID, schema: 'Example_Context' }],
    ['table', { ...VALID, table: '1item' }],
    ['instanceIdColumn', { ...VALID, instanceIdColumn: 'ItemId' }],
  ])('rejects a non-conforming %s identifier', (_label, contract) => {
    expect(() => createPipelineTableContract(contract as PipelineTableContract)).toThrow(
      ValidationError,
    );
  });

  it('rejects an empty stages list', () => {
    expect(() => createPipelineTableContract({ ...VALID, stages: [] })).toThrow(ValidationError);
  });

  it('rejects a non-conforming stage identifier', () => {
    expect(() =>
      createPipelineTableContract({ ...VALID, stages: ['enrich', 'Distribute'] }),
    ).toThrow(ValidationError);
  });

  it('rejects instanceIdColumn that is not "<table>_id" (ADR-0011)', () => {
    expect(() => createPipelineTableContract({ ...VALID, instanceIdColumn: 'id' })).toThrow(
      ValidationError,
    );
  });

  it('rejects a table name whose derived stage-status FK constraint name exceeds 63 bytes (ADR-0011)', () => {
    const longTable = 'a'.repeat(40);
    expect(() =>
      createPipelineTableContract({
        ...VALID,
        table: longTable,
        instanceIdColumn: `${longTable}_id`,
        stages: ['enrich'],
      }),
    ).toThrow(ValidationError);
  });

  it('accepts a table name at the byte-length boundary', () => {
    // fk_{table}__stage_status__{stage} must stay <= 63 bytes.
    const table = 'item';
    const stage = 'a'.repeat(30);
    expect(() =>
      createPipelineTableContract({
        pipeline: 'example',
        schema: 'example_context',
        table,
        instanceIdColumn: `${table}_id`,
        stages: [stage],
      }),
    ).not.toThrow();
  });
});
