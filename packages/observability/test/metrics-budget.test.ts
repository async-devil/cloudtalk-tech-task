import { ValidationError } from '@repo/kernel';
import { describe, expect, it } from 'vitest';
import { createModuleObservability, type MetricAttribute } from '../src/index.js';

const obs = createModuleObservability('notes');

describe('cardinality budget (ADR-0009, INV-2): structural, not reviewed-in', () => {
  it('rejects an instrument spec asking for an attribute outside the budget enum', () => {
    expect(() =>
      obs.createCounter({
        name: 'notes.note.create',
        // The type system already forbids this; the runtime check is the last line for JS callers.
        allowedAttributes: ['tenant_id' as MetricAttribute],
      }),
    ).toThrow(ValidationError);
  });

  it('rejects recording an attribute the spec did not declare', () => {
    const counter = obs.createCounter({
      name: 'notes.note.create',
      allowedAttributes: ['outcome'],
    });
    expect(() => counter.add(1, { stage: 'x' })).toThrow(ValidationError);
  });

  it('accepts declared attributes and records without a meter provider (noop)', () => {
    const histogram = obs.createHistogram({
      name: 'notes.note.create',
      unit: 'ms',
      allowedAttributes: ['outcome', 'status_class'],
    });
    expect(() => histogram.record(12, { outcome: 'ok' })).not.toThrow();
  });

  it('validates instrument names like span names (module-prefixed, three segments)', () => {
    expect(() => obs.createCounter({ name: 'other.note.create', allowedAttributes: [] })).toThrow(
      ValidationError,
    );
    expect(() => obs.createCounter({ name: 'notes.create', allowedAttributes: [] })).toThrow(
      ValidationError,
    );
  });
});
