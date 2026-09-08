// The `./sdk` entry — programmatic OTel SDK wiring (ADR-0009: SDK exactly once per app, first
// thing in the composition root). Importable ONLY from `apps/*/src/runtime/` (dep-cruiser rule);
// product modules use the facade entry (`@repo/observability`) which touches the API only.

import process from 'node:process';
import { metrics } from '@opentelemetry/api';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { defaultResource, resourceFromAttributes } from '@opentelemetry/resources';
import { type IMetricReader, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { APP_MODE, type AppMode, isFailClosed } from '@repo/config';
import { InternalError } from '@repo/kernel';
import { buildProcessLogger, setProcessLogger } from './internal/logger-state.js';

/**
 * How metric datapoints acquire their trace exemplars (ADR-0009).
 * - `collector-spanmetrics` (default, live): the app records measurements in-span and emits
 *   exemplar-less OTLP datapoints; the OTel Collector's spanmetrics connector derives
 *   exemplar-bearing RED metrics from the spans. This is ADR-0009's named fallback.
 * - `sdk-native` (reserved seam): native SDK exemplars on the app-emitted datapoints — the future
 *   swap for when `@opentelemetry/sdk-metrics` can export exemplars. Selecting it throws today.
 *
 * Declared once as a const-object value set (ADR-0003): the `ExemplarStrategy` union and the
 * `EXEMPLAR_STRATEGIES` list derive from it, and call sites reference members
 * (`EXEMPLAR_STRATEGY.CollectorSpanmetrics`) rather than raw string literals.
 */
export const EXEMPLAR_STRATEGY = {
  CollectorSpanmetrics: 'collector-spanmetrics',
  SdkNative: 'sdk-native',
} as const;
export type ExemplarStrategy = (typeof EXEMPLAR_STRATEGY)[keyof typeof EXEMPLAR_STRATEGY];
export const EXEMPLAR_STRATEGIES = Object.values(EXEMPLAR_STRATEGY) as readonly ExemplarStrategy[];

export interface ObservabilityInitOptions {
  readonly mode: AppMode;
  /** resource: service.name */
  readonly serviceName: string;
  readonly serviceVersion: string;
  readonly serviceNamespace: string;
  readonly deploymentEnvironment: string;
  /** Base OTLP-HTTP endpoint; required in fail-closed tiers (staging/production). When absent
   * (`test` without a backend), tracing still works process-locally — spans record, logs
   * correlate — but nothing exports. */
  readonly otlpEndpoint?: string;
  /** Default 10_000. */
  readonly metricExportIntervalMs?: number;
  /** pino level for the process logger (observability config slice); default 'info'. */
  readonly logLevel?: string;
  /** Exemplar strategy (ADR-0009); default `'collector-spanmetrics'`. */
  readonly exemplarStrategy?: ExemplarStrategy;
}

export interface ObservabilityHandle {
  /** Flushes exporters; the composition root calls this on SIGTERM/SIGINT. */
  shutdown(): Promise<void>;
}

/** Semconv resource attribute keys, pinned at v1.37.0 (ADR-0009: upgrading the pinned version is
 * an ADR amendment, not a drive-by edit). String literals rather than the constants package — one
 * fewer dependency for four stable keys. */
const ATTR_SERVICE_NAME = 'service.name';
const ATTR_SERVICE_VERSION = 'service.version';
const ATTR_SERVICE_NAMESPACE = 'service.namespace';
const ATTR_SERVICE_INSTANCE_ID = 'service.instance.id';
const ATTR_DEPLOYMENT_ENVIRONMENT = 'deployment.environment.name';

let started = false;

/**
 * The exemplar-strategy seam (ADR-0009). Only `collector-spanmetrics` is live: the app records
 * measurements in-span (see the metrics facade) and the OTel Collector's spanmetrics connector
 * turns those spans into exemplar-bearing RED metrics — so nothing is wired SDK-side here.
 * `sdk-native` is the reserved swap point: when `@opentelemetry/sdk-metrics` can export exemplars,
 * enabling the reservoir/filter on the metric readers goes HERE and the integration suite's
 * expected-failure exemplar assertion flips to a hard assertion. Until then it throws loudly
 * rather than silently producing exemplar-less datapoints that masquerade as native.
 */
function applyExemplarStrategy(strategy: ExemplarStrategy): void {
  if (strategy === EXEMPLAR_STRATEGY.SdkNative) {
    throw new InternalError(
      "exemplarStrategy 'sdk-native' is unavailable at @opentelemetry/sdk-metrics 2.4.0 " +
        '(no exemplar export — ADR-0009); use collector-spanmetrics until the SDK supports it. ' +
        'Implement the reservoir/filter enablement here when it does.',
    );
  }
  // 'collector-spanmetrics': the collector derives exemplars from spans — nothing to wire SDK-side.
}

/**
 * Wires the OTel SDK + the process logger, exactly once per app (ADR-0009). A second call
 * throws — two SDKs in one process is the half-configured-state class ADR-0005 exists to kill.
 *
 * Exemplars follow the {@link ExemplarStrategy} (ADR-0009): the default `collector-spanmetrics`
 * delivers the metrics→traces link from the collector; `sdk-native` is the reserved future swap.
 * The pinned `@opentelemetry/sdk-metrics` 2.4.0 cannot emit native exemplars on any runtime, which
 * is why the collector fallback is the live path — the app still records every measurement inside
 * an active span so the collector (and, later, the SDK) has the trace context to attach.
 */
export function initObservability(options: ObservabilityInitOptions): ObservabilityHandle {
  if (started) {
    throw new InternalError('initObservability called twice — the SDK is wired once per app');
  }

  applyExemplarStrategy(options.exemplarStrategy ?? EXEMPLAR_STRATEGY.CollectorSpanmetrics);
  if (isFailClosed(options.mode) && options.otlpEndpoint === undefined) {
    throw new InternalError('initObservability: otlpEndpoint is required in staging/production');
  }

  started = true;

  const resource = defaultResource().merge(
    resourceFromAttributes({
      [ATTR_SERVICE_NAME]: options.serviceName,
      [ATTR_SERVICE_VERSION]: options.serviceVersion,
      [ATTR_SERVICE_NAMESPACE]: options.serviceNamespace,
      [ATTR_SERVICE_INSTANCE_ID]: crypto.randomUUID(),
      [ATTR_DEPLOYMENT_ENVIRONMENT]: options.deploymentEnvironment,
    }),
  );

  const exporters: {
    traceExporter?: OTLPTraceExporter;
    metricReaders?: IMetricReader[];
  } = {};

  if (options.otlpEndpoint !== undefined) {
    exporters.traceExporter = new OTLPTraceExporter({ url: `${options.otlpEndpoint}/v1/traces` });
    exporters.metricReaders = [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ url: `${options.otlpEndpoint}/v1/metrics` }),
        exportIntervalMillis: options.metricExportIntervalMs ?? 10_000,
      }),
    ];
  }

  const sdk = new NodeSDK({ resource, autoDetectResources: false, ...exporters });
  sdk.start();

  setProcessLogger(
    buildProcessLogger({
      level: options.logLevel ?? 'info',
      // Pretty output is dev-only (ADR-0009): test mode on a TTY; JSON single-line everywhere else.
      pretty: options.mode === APP_MODE.Test && Boolean(process.stdout.isTTY),
    }),
  );

  return {
    async shutdown(): Promise<void> {
      started = false;
      metrics.disable();
      await sdk.shutdown();
    },
  };
}
