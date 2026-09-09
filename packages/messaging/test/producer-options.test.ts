import { describe, expect, it } from 'vitest';
import { producerJobOptions } from '../src/internal/producer-options.js';

describe('producerJobOptions', () => {
  it('matches the frozen producer defaults shape', () => {
    expect(producerJobOptions('uppercase-note', 'note-1', 5)).toStrictEqual({
      jobId: 'uppercase-note_note-1',
      attempts: 5,
      backoff: { type: 'custom' },
      removeOnComplete: { count: 1000 },
      removeOnFail: false,
    });
  });

  it('generalizes to different stage/entityId/attempts values', () => {
    expect(producerJobOptions('lowercase-order', 'order-42', 3)).toStrictEqual({
      jobId: 'lowercase-order_order-42',
      attempts: 3,
      backoff: { type: 'custom' },
      removeOnComplete: { count: 1000 },
      removeOnFail: false,
    });
  });
});
