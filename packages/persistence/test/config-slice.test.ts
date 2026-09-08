import { describe, expect, it } from 'vitest';
import { configSlice } from '../src/index.js';

describe('configSlice', () => {
  it('is keyed "persistence"', () => {
    expect(configSlice.key).toBe('persistence');
  });

  // INV-4 (fallback half)
  it('test mode: DATABASE_OWNER_URL falls back to DATABASE_URL; DATABASE_POOL_SIZE defaults to 10', () => {
    const parsed = configSlice.schema('test').parse({ DATABASE_URL: 'postgres://app@host/db' });
    expect(parsed).toEqual({
      DATABASE_URL: 'postgres://app@host/db',
      DATABASE_OWNER_URL: 'postgres://app@host/db',
      DATABASE_POOL_SIZE: 10,
    });
  });

  it('coerces DATABASE_POOL_SIZE from its env string form', () => {
    const parsed = configSlice.schema('test').parse({
      DATABASE_URL: 'postgres://app@host/db',
      DATABASE_POOL_SIZE: '25',
    });
    expect(parsed.DATABASE_POOL_SIZE).toBe(25);
  });

  it('keeps an explicitly provided DATABASE_OWNER_URL in any mode', () => {
    const parsed = configSlice.schema('production').parse({
      DATABASE_URL: 'postgres://app@host/db',
      DATABASE_OWNER_URL: 'postgres://owner@host/db',
    });
    expect(parsed.DATABASE_OWNER_URL).toBe('postgres://owner@host/db');
  });

  // INV-4 (fail-closed-required half)
  it('production: missing DATABASE_OWNER_URL is a parse failure naming the key', () => {
    const result = configSlice
      .schema('production')
      .safeParse({ DATABASE_URL: 'postgres://a@h/db' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.includes('DATABASE_OWNER_URL'))).toBe(
        true,
      );
    }
  });

  it('DATABASE_URL is required in every mode', () => {
    for (const mode of ['test', 'staging', 'production'] as const) {
      expect(configSlice.schema(mode).safeParse({}).success).toBe(false);
    }
  });
});
