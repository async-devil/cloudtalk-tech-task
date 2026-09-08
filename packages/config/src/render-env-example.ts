import { z } from 'zod';
import { APP_MODE } from './mode.js';
import type { ConfigSlice } from './slice.js';

// Narrowed to just the fields this renderer reads. `z.toJSONSchema`'s real return type is a
// broad, general-purpose JSON Schema shape; a documented cast through `unknown` (see below) is
// used rather than importing that full surface (CLAUDE.md: no `any` without a written
// constraint — this is that constraint).
interface EnvExampleFieldSchema {
  readonly description?: string;
  readonly default?: string | number | boolean;
}
interface EnvExampleObjectSchema {
  readonly properties?: Readonly<Record<string, EnvExampleFieldSchema>>;
  readonly required?: ReadonlyArray<string>;
}

const HEADER = `# Copy this file to .env — NEVER commit .env (it is gitignored).
# .env is loaded only in \`test\` mode; comments must be on their OWN line
# (the config parser treats \`#\` as whole-line comments — an inline \`# note\`
# after a value becomes part of the value).
#
# Generated from the composed config slice schemas — do not hand-edit; edit the owning slice's
# \`.describe()\` annotations instead.

# --- boot ---------------------------------------------------------------
# Required: test | staging | production. No default — boot refuses without it (ADR-0005).
# \`test\` uses stubs + lenient config (local dev / CI); staging & production are real + fail-closed.
APP_MODE=`;

const SECTION_WIDTH = 78;

/**
 * One env key that belongs in `.env.example` but is NOT parsed by any config slice.
 *
 * This exists for exactly one shape: a build-time key consumed OUTSIDE the config module — Vite
 * inlines `VITE_*` into the browser bundle, so `@repo/config` never sees it and a `ConfigSlice`
 * for it would be a lie (boot would parse, and could require, a variable no server process uses).
 * It still has to be documented in the one generated `.env.example` file, so a hand-added section
 * there is precisely what an env-example consistency check would fail on.
 */
export interface EnvDocumentationEntry {
  readonly name: string;
  readonly description: string;
  /** Rendered as the commented default, like a slice field's `.default()`. */
  readonly defaultValue?: string;
}

export interface EnvDocumentationSection {
  /** The section header, in the same `# --- <key> ---…` form slice sections use. */
  readonly key: string;
  readonly entries: ReadonlyArray<EnvDocumentationEntry>;
}

/**
 * Renders the canonical `.env.example` from the composed slice schemas: one section per slice
 * (slice key as header comment), one line per env key with its `.describe()` annotation and
 * default. Deterministic output — byte-stable across runs.
 *
 * Requiredness/default is read off each slice's `test`-mode schema: every field name is
 * mode-invariant (only `.optional()`/`.default()` status differs across `AppMode`, per the
 * slices' own frozen shapes), and `test` is the one mode where every fail-closed-only key still
 * carries a default — so a single schema call per slice is enough to classify every key.
 *
 * `documentationSections` are appended AFTER every slice section: keys that are documented here
 * but parsed elsewhere (see {@link EnvDocumentationSection}). They are deliberately last, so the
 * file reads as "everything this process parses, then everything else that belongs in `.env`".
 */
export function renderEnvExample(
  slices: ReadonlyArray<ConfigSlice<z.ZodType>>,
  documentationSections: ReadonlyArray<EnvDocumentationSection> = [],
): string {
  const sections = slices.map((slice) => renderSection(slice));
  const documented = documentationSections.map((section) => renderDocumentationSection(section));
  return `${[HEADER, ...sections, ...documented].join('\n\n')}\n`;
}

function renderDocumentationSection(section: EnvDocumentationSection): string {
  const lines = [sectionHeader(section.key)];
  for (const entry of section.entries) {
    for (const descriptionLine of entry.description.split('\n')) {
      lines.push(`# ${descriptionLine}`);
    }
    lines.push(`# ${entry.name}=${entry.defaultValue ?? ''}`);
  }
  return lines.join('\n');
}

function renderSection(slice: ConfigSlice<z.ZodType>): string {
  const schema = slice.schema(APP_MODE.Test);
  // Documented cast (constraint above): `z.toJSONSchema`'s generic return type is wider than
  // what this renderer reads, and `io: 'input'` resolves refinements/transforms/effects down to
  // the underlying object schema's own properties/required list.
  const jsonSchema = z.toJSONSchema(schema, { io: 'input' }) as unknown as EnvExampleObjectSchema;
  const properties = jsonSchema.properties ?? {};
  const required = new Set(jsonSchema.required ?? []);

  const lines = [sectionHeader(slice.key)];
  for (const [key, field] of Object.entries(properties)) {
    if (field.description !== undefined) {
      for (const descriptionLine of field.description.split('\n')) {
        lines.push(`# ${descriptionLine}`);
      }
    }
    if (field.default !== undefined) {
      lines.push(`# ${key}=${String(field.default)}`);
    } else if (required.has(key)) {
      lines.push(`${key}=`);
    } else {
      lines.push(`# ${key}=`);
    }
  }
  return lines.join('\n');
}

function sectionHeader(key: string): string {
  return `# --- ${key} `.padEnd(SECTION_WIDTH, '-');
}
