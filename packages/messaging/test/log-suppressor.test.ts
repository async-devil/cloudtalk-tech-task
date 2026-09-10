import { describe, expect, it, vi } from 'vitest';
import { createIntervalSuppressor } from '../src/internal/log-suppressor.js';

describe('createIntervalSuppressor', () => {
  it('first call always logs immediately', () => {
    vi.useFakeTimers();
    try {
      const warnFn = vi.fn();
      const fakeLogger = {
        warn: warnFn,
        error: () => {
          // mocked
        },
        info: () => {
          // mocked
        },
        debug: () => {
          // mocked
        },
        fatal: () => {
          // mocked
        },
        child: (_bindings: object) => fakeLogger,
      };

      const suppressor = createIntervalSuppressor(60_000);
      suppressor(fakeLogger, 'first message');

      expect(warnFn).toHaveBeenCalledTimes(1);
      const firstCallArgs = warnFn.mock.calls[0];
      if (firstCallArgs === undefined) {
        throw new Error('expected warnFn to have recorded a first call');
      }
      const [firstCall] = firstCallArgs;
      expect(firstCall).toEqual({ suppressedCount: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('second call within interval is suppressed', () => {
    vi.useFakeTimers();
    try {
      const warnFn = vi.fn();
      const fakeLogger = {
        warn: warnFn,
        error: () => {
          // mocked
        },
        info: () => {
          // mocked
        },
        debug: () => {
          // mocked
        },
        fatal: () => {
          // mocked
        },
        child: (_bindings: object) => fakeLogger,
      };

      const suppressor = createIntervalSuppressor(60_000);
      suppressor(fakeLogger, 'first message');
      suppressor(fakeLogger, 'second message');

      expect(warnFn).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('call after interval elapsed logs again with suppressedCount', () => {
    vi.useFakeTimers();
    try {
      const warnFn = vi.fn();
      const fakeLogger = {
        warn: warnFn,
        error: () => {
          // mocked
        },
        info: () => {
          // mocked
        },
        debug: () => {
          // mocked
        },
        fatal: () => {
          // mocked
        },
        child: (_bindings: object) => fakeLogger,
      };

      const suppressor = createIntervalSuppressor(60_000);
      suppressor(fakeLogger, 'first message');

      vi.advanceTimersByTime(30_000);
      suppressor(fakeLogger, 'suppressed 1');
      suppressor(fakeLogger, 'suppressed 2');
      suppressor(fakeLogger, 'suppressed 3');

      vi.advanceTimersByTime(40_000);
      suppressor(fakeLogger, 'message after interval');

      expect(warnFn).toHaveBeenCalledTimes(2);
      const secondCallArgs = warnFn.mock.calls[1];
      if (secondCallArgs === undefined) {
        throw new Error('expected warnFn to have recorded a second call');
      }
      const [secondCall] = secondCallArgs;
      expect(secondCall).toEqual({ suppressedCount: 3 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('respects custom intervalMs', () => {
    vi.useFakeTimers();
    try {
      const warnFn = vi.fn();
      const fakeLogger = {
        warn: warnFn,
        error: () => {
          // mocked
        },
        info: () => {
          // mocked
        },
        debug: () => {
          // mocked
        },
        fatal: () => {
          // mocked
        },
        child: (_bindings: object) => fakeLogger,
      };

      const suppressor = createIntervalSuppressor(100);
      suppressor(fakeLogger, 'first message');

      vi.advanceTimersByTime(50);
      suppressor(fakeLogger, 'suppressed');

      vi.advanceTimersByTime(60);
      suppressor(fakeLogger, 'message after custom interval');

      expect(warnFn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
