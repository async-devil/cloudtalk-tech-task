import { describe, expect, it } from 'vitest';
import { workerLimiterOptions } from '../src/internal/worker-limiter.js';

describe('workerLimiterOptions (ADR-0014, frozen mapping)', () => {
  it("maps { max, durationMs } to BullMQ's { max, duration }", () => {
    expect(workerLimiterOptions({ max: 10, durationMs: 1000 })).toStrictEqual({
      max: 10,
      duration: 1000,
    });
  });

  it('maps max=5, durationMs=500', () => {
    expect(workerLimiterOptions({ max: 5, durationMs: 500 })).toStrictEqual({
      max: 5,
      duration: 500,
    });
  });

  it('maps max=1, durationMs=60000', () => {
    expect(workerLimiterOptions({ max: 1, durationMs: 60000 })).toStrictEqual({
      max: 1,
      duration: 60000,
    });
  });

  it('maps max=100, durationMs=10000', () => {
    expect(workerLimiterOptions({ max: 100, durationMs: 10000 })).toStrictEqual({
      max: 100,
      duration: 10000,
    });
  });
});
