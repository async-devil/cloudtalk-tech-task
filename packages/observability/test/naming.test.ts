import { isAppError, ValidationError } from '@repo/kernel';
import { describe, expect, it } from 'vitest';
import { createModuleObservability, withBusEventSpan, withJobStageSpan } from '../src/index.js';

const noop = (): undefined => undefined;

describe('span/instrument naming (ADR-0009, INV-1)', () => {
  it('rejects a module name that is not a lowercase segment', () => {
    expect(() => createModuleObservability('Notes')).toThrow(ValidationError);
    expect(() => createModuleObservability('notes.api')).toThrow(ValidationError);
  });

  it('rejects span names that are not {module}.{object}.{verb}', () => {
    const obs = createModuleObservability('notes');
    for (const bad of ['create', 'notes.create', 'notes.note.Create', 'notes.note.create.x']) {
      expect(() => obs.withSpan(bad, noop), bad).toThrow(ValidationError);
    }
  });

  it('rejects a span name claiming another module namespace', () => {
    const obs = createModuleObservability('notes');
    expect(() => obs.withSpan('billing.invoice.create', noop)).toThrow(ValidationError);
  });

  it('throws kernel-typed errors (detectable via isAppError, never name-matching)', () => {
    const obs = createModuleObservability('notes');
    try {
      void obs.withSpan('nope', noop);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(isAppError(err)).toBe(true);
    }
  });

  it('rejects job pipeline/stage segments outside [a-z0-9-]', () => {
    expect(() => withJobStageSpan({ pipeline: 'Slice', stage: 'x' }, noop)).toThrow(
      ValidationError,
    );
    expect(() => withJobStageSpan({ pipeline: 'slice', stage: 'up.per' }, noop)).toThrow(
      ValidationError,
    );
  });

  it('rejects bus event types that are not lowercase dot-separated segments', () => {
    for (const bad of ['NoteProcessed', 'note', 'note..processed', 'note.Processed']) {
      expect(() => withBusEventSpan({ eventType: bad }, noop), bad).toThrow(ValidationError);
    }
  });
});
