import { describe, expect, it } from 'vitest';
import { buildEnvelope } from '../src/internal/envelope.js';

describe('buildEnvelope', () => {
  it('carries the trace carrier fields alongside data (frozen envelope shape)', () => {
    expect(buildEnvelope({ noteId: 'n1' }, { traceparent: 'tp', tracestate: 'ts' })).toStrictEqual({
      traceparent: 'tp',
      tracestate: 'ts',
      data: { noteId: 'n1' },
    });
  });

  it('omits carrier fields when the carrier is empty (no active span)', () => {
    expect(buildEnvelope({ noteId: 'n1' }, {})).toStrictEqual({ data: { noteId: 'n1' } });
  });
});
