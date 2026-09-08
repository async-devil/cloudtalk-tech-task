import { type Counter, type Histogram, metrics } from '@opentelemetry/api';
import { ValidationError } from '@repo/kernel';
import { assertModuleName } from './internal/naming.js';

/**
 * The ADR-0009 cardinality budget, as a closed value set (ADR-0003): attributes on metrics are
 * bounded enums only. Never tenant/user/entity ids, experiment keys, or raw URLs — those live on
 * spans. Declared once as a const object; the `MetricAttribute` union, the `METRIC_ATTRIBUTES`
 * membership Set, and the parse boundary all derive from it — no hand-maintained parallel list.
 * Extending it is a reviewed change to THIS file plus the budget table in the README.
 */
export const METRIC_ATTRIBUTE = {
  Route: 'route',
  Method: 'method',
  StatusClass: 'status_class',
  Stage: 'stage',
  Outcome: 'outcome',
  Queue: 'queue',
} as const;
export type MetricAttribute = (typeof METRIC_ATTRIBUTE)[keyof typeof METRIC_ATTRIBUTE];

const METRIC_ATTRIBUTES: ReadonlySet<string> = new Set(Object.values(METRIC_ATTRIBUTE));

export interface InstrumentSpecification {
  /** `{module}.{object}.{verb}` — validated against the owning module (ADR-0009 naming). */
  readonly name: string;
  readonly description?: string;
  readonly unit?: string;
  /** The subset of the budget this instrument may record; anything else throws. */
  readonly allowedAttributes: ReadonlyArray<MetricAttribute>;
}

export interface FacadeCounter {
  add(value: number, attributes?: Partial<Record<MetricAttribute, string>>): void;
}

export interface FacadeHistogram {
  record(value: number, attributes?: Partial<Record<MetricAttribute, string>>): void;
}

const METER_NAME = '@repo/observability';

function assertSpecification(moduleName: string, specification: InstrumentSpecification): void {
  assertModuleName(moduleName, specification.name, 'instrument name');
  for (const attribute of specification.allowedAttributes) {
    if (!METRIC_ATTRIBUTES.has(attribute)) {
      throw new ValidationError(
        `instrument "${specification.name}" requests attribute "${attribute}" outside the ADR-0009 budget`,
      );
    }
  }
}

function checkAttributes(
  specification: InstrumentSpecification,
  attributes: Partial<Record<MetricAttribute, string>> | undefined,
): void {
  if (attributes === undefined) {
    return;
  }
  for (const key of Object.keys(attributes)) {
    if (!specification.allowedAttributes.includes(key as MetricAttribute)) {
      throw new ValidationError(
        `instrument "${specification.name}" recorded attribute "${key}" not in its allowedAttributes — the cardinality budget is structural (ADR-0009)`,
      );
    }
  }
}

/**
 * Lazily resolves the underlying OTel instrument on first use: the API's global meter provider
 * is registered by `initObservability`, which the boot order runs before any measurement — but
 * module factories may be *constructed* earlier without penalty.
 */
export function createModuleCounter(
  moduleName: string,
  specification: InstrumentSpecification,
): FacadeCounter {
  assertSpecification(moduleName, specification);
  let counter: Counter | undefined;
  return {
    add(value, attributes): void {
      checkAttributes(specification, attributes);
      counter ??= metrics.getMeter(METER_NAME).createCounter(specification.name, {
        ...(specification.description !== undefined
          ? { description: specification.description }
          : {}),
        ...(specification.unit !== undefined ? { unit: specification.unit } : {}),
      });
      counter.add(value, attributes);
    },
  };
}

/** See {@link createModuleCounter}; histograms additionally require a unit. */
export function createModuleHistogram(
  moduleName: string,
  specification: InstrumentSpecification & { unit: string },
): FacadeHistogram {
  assertSpecification(moduleName, specification);
  let histogram: Histogram | undefined;
  return {
    record(value, attributes): void {
      checkAttributes(specification, attributes);
      histogram ??= metrics.getMeter(METER_NAME).createHistogram(specification.name, {
        ...(specification.description !== undefined
          ? { description: specification.description }
          : {}),
        unit: specification.unit,
      });
      histogram.record(value, attributes);
    },
  };
}
