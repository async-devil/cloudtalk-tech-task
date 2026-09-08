import { describe, expect, it } from 'vitest';
import { ConfigError, readAppMode } from '../src/index.js';

describe('readAppMode', () => {
  it.each(['test', 'staging', 'production'] as const)('accepts "%s"', (mode) => {
    expect(readAppMode({ APP_MODE: mode })).toBe(mode);
  });

  it('throws ConfigError when APP_MODE is missing', () => {
    expect(() => readAppMode({})).toThrow(ConfigError);
    try {
      readAppMode({});
      throw new Error('unreachable');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).issues).toEqual([
        { key: 'APP_MODE', message: expect.stringContaining('required') },
      ]);
    }
  });

  it('throws ConfigError when APP_MODE is unrecognized (no NODE_ENV inference)', () => {
    try {
      // 'live' is the pre-deployment-tier value ADR-0005 retired — now rejected;
      // NODE_ENV must not rescue it.
      readAppMode({ APP_MODE: 'live', NODE_ENV: 'production' });
      throw new Error('unreachable');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).issues[0]?.key).toBe('APP_MODE');
    }
  });
});
