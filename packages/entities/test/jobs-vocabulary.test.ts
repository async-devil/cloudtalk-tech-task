import { describe, expect, it } from 'vitest';
import {
  BRANCH_KIND,
  BRANCH_STATUS,
  branchKindRowSchema,
  branchStatusRowSchema,
  OUTBOX_ROW_STATUS,
  outboxRowStatusRowSchema,
  STAGE_STATUS,
  stageStatusRowSchema,
} from '../src/index.js';

// ADR-0006: each vocabulary const object is `{ id, name }` records, never a bare `name -> id`
// map — the shape a `SELECT * FROM reference.<vocabulary>` parity test
// (packages/jobs/test-integration/reference-parity.test.ts) compares against with zero
// transformation in between.
describe('STAGE_STATUS (jobs spine)', () => {
  it('is a closed { id, name } record set, ids never renumbered', () => {
    expect(STAGE_STATUS).toStrictEqual({
      Pending: { id: 1, name: 'pending' },
      InProgress: { id: 2, name: 'in_progress' },
      Completed: { id: 3, name: 'completed' },
      Failed: { id: 4, name: 'failed' },
    });
  });

  it('every row parses through stageStatusRowSchema (ADR-0008)', () => {
    for (const row of Object.values(STAGE_STATUS)) {
      expect(stageStatusRowSchema.parse({ stage_status_id: row.id, name: row.name })).toStrictEqual(
        { stage_status_id: row.id, name: row.name },
      );
    }
  });
});

describe('BRANCH_STATUS (jobs spine)', () => {
  it('is a closed { id, name } record set', () => {
    expect(BRANCH_STATUS).toStrictEqual({
      Pending: { id: 1, name: 'pending' },
      Completed: { id: 2, name: 'completed' },
      Failed: { id: 3, name: 'failed' },
    });
  });

  it('every row parses through branchStatusRowSchema (ADR-0008)', () => {
    for (const row of Object.values(BRANCH_STATUS)) {
      expect(
        branchStatusRowSchema.parse({ branch_status_id: row.id, name: row.name }),
      ).toStrictEqual({ branch_status_id: row.id, name: row.name });
    }
  });
});

describe('BRANCH_KIND (jobs spine)', () => {
  it('is a closed { id, name } record set — every branch kind reaches the same ceiling', () => {
    expect(BRANCH_KIND).toStrictEqual({
      Owned: { id: 1, name: 'owned' },
      Delegated: { id: 2, name: 'delegated' },
    });
  });

  it('every row parses through branchKindRowSchema (ADR-0008)', () => {
    for (const row of Object.values(BRANCH_KIND)) {
      expect(branchKindRowSchema.parse({ branch_kind_id: row.id, name: row.name })).toStrictEqual({
        branch_kind_id: row.id,
        name: row.name,
      });
    }
  });
});

describe('OUTBOX_ROW_STATUS (jobs spine)', () => {
  it('is a closed { id, name } record set — Processed replaces the dual-source processed_at reading', () => {
    expect(OUTBOX_ROW_STATUS).toStrictEqual({
      Pending: { id: 1, name: 'pending' },
      Processed: { id: 2, name: 'processed' },
      Dead: { id: 3, name: 'dead' },
    });
  });

  it('every row parses through outboxRowStatusRowSchema (ADR-0008)', () => {
    for (const row of Object.values(OUTBOX_ROW_STATUS)) {
      expect(
        outboxRowStatusRowSchema.parse({ outbox_row_status_id: row.id, name: row.name }),
      ).toStrictEqual({ outbox_row_status_id: row.id, name: row.name });
    }
  });
});
