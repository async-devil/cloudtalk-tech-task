import { describe, expect, it } from 'vitest';
import { repeatableJobTemplate, repeatOptionsFrom } from '../src/internal/repeatable-options.js';

describe('repeatableJobTemplate (frozen invariant)', () => {
  it('carries the producer defaults (attempts, custom backoff, retention)', () => {
    const template = repeatableJobTemplate('digest', { userId: 'u1' });
    expect(template.name).toBe('digest');
    expect(template.opts).toStrictEqual({
      attempts: 5,
      backoff: { type: 'custom' },
      removeOnComplete: { count: 1000 },
      removeOnFail: false,
    });
  });

  it('the scheduled envelope carries NO traceparent — a tick has no producer trace', () => {
    const template = repeatableJobTemplate('digest', { userId: 'u1' });
    expect(template.data).toStrictEqual({ data: { userId: 'u1' } });
    expect('traceparent' in template.data).toBe(false);
  });
});

describe('repeatOptionsFrom (milliseconds/cronPattern -> BullMQ every/pattern)', () => {
  it('maps a milliseconds interval to { every }', () => {
    expect(repeatOptionsFrom({ milliseconds: 60_000 })).toStrictEqual({ every: 60_000 });
  });

  it('maps a cron pattern to { pattern }', () => {
    expect(repeatOptionsFrom({ cronPattern: '0 * * * *' })).toStrictEqual({
      pattern: '0 * * * *',
    });
  });
});
