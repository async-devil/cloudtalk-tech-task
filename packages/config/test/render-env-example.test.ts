import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineConfigSlice, renderEnvExample } from '../src/index.js';

describe('renderEnvExample', () => {
  it('renders one section per slice, in slice order', () => {
    const apiSlice = defineConfigSlice('api', () =>
      z.object({ PORT: z.coerce.number().default(3000).describe('API listen port.') }),
    );
    const dbSlice = defineConfigSlice('persistence', () =>
      z.object({ DATABASE_URL: z.string().min(1).describe('Required. Connection string.') }),
    );

    const rendered = renderEnvExample([apiSlice, dbSlice]);
    const apiIndex = rendered.indexOf('--- api ');
    const dbIndex = rendered.indexOf('--- persistence ');

    expect(apiIndex).toBeGreaterThan(-1);
    expect(dbIndex).toBeGreaterThan(apiIndex);
  });

  it('always includes the APP_MODE boot preamble, regardless of slices', () => {
    const rendered = renderEnvExample([]);
    expect(rendered).toContain('APP_MODE=');
    expect(rendered).toContain('boot refuses without it');
  });

  it('renders a required, no-default key as an uncommented empty line', () => {
    const slice = defineConfigSlice('persistence', () =>
      z.object({ DATABASE_URL: z.string().min(1).describe('Required.') }),
    );
    const rendered = renderEnvExample([slice]);
    expect(rendered).toContain('\nDATABASE_URL=\n');
    expect(rendered).not.toContain('# DATABASE_URL=');
  });

  it('renders a defaulted key as a commented line showing the default', () => {
    const slice = defineConfigSlice('api', () =>
      z.object({ PORT: z.coerce.number().default(3000).describe('Port.') }),
    );
    const rendered = renderEnvExample([slice]);
    expect(rendered).toContain('# PORT=3000');
  });

  it('renders an optional, no-default key as a commented empty line', () => {
    const slice = defineConfigSlice('persistence', () =>
      z.object({ DATABASE_OWNER_URL: z.string().min(1).optional().describe('Optional.') }),
    );
    const rendered = renderEnvExample([slice]);
    expect(rendered).toContain('# DATABASE_OWNER_URL=\n');
  });

  it("includes each field's .describe() text as a comment line", () => {
    const slice = defineConfigSlice('api', () =>
      z.object({ PORT: z.coerce.number().default(3000).describe('Distinctive marker text.') }),
    );
    const rendered = renderEnvExample([slice]);
    expect(rendered).toContain('# Distinctive marker text.');
  });

  it('is deterministic — identical input renders byte-identical output', () => {
    const slice = defineConfigSlice('api', () =>
      z.object({
        PORT: z.coerce.number().default(3000).describe('Port.'),
        HOST: z.string().default('0.0.0.0').describe('Host.'),
      }),
    );
    expect(renderEnvExample([slice])).toBe(renderEnvExample([slice]));
  });
});
