import { describe, expect, it } from 'vitest';
import { jobIdFor } from '../src/index.js';

describe('jobIdFor', () => {
  it('is "stage_entityId" (named invariant)', () => {
    expect(jobIdFor('uppercase-note', 'abc-123')).toBe('uppercase-note_abc-123');
  });

  it('is deterministic for the same inputs (dedup via BullMQ jobId)', () => {
    expect(jobIdFor('stage', 'entity')).toBe(jobIdFor('stage', 'entity'));
  });

  it('handles entityId containing UUID with dashes', () => {
    expect(jobIdFor('stage', '123e4567-e89b-12d3-a456-426614174000')).toBe(
      'stage_123e4567-e89b-12d3-a456-426614174000',
    );
  });

  it('handles empty-string entityId', () => {
    expect(jobIdFor('stage', '')).toBe('stage_');
  });
});
