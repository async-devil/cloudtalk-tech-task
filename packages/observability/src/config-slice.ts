import { defineConfigSlice, isFailClosed } from '@repo/config';
import { z } from 'zod';

/**
 * The observability config slice (ADR-0005):
 *
 * | env key | required | default (non-live) |
 * |---|---|---|
 * | `OTEL_EXPORTER_OTLP_ENDPOINT` | live | `http://localhost:4318` |
 * | `OTEL_SERVICE_NAME` | no | `api` |
 * | `OTEL_SERVICE_NAMESPACE` | no | `reviews` |
 * | `DEPLOYMENT_ENVIRONMENT` | live | `dev` |
 * | `LOG_LEVEL` | no | `info` |
 *
 * The composition root feeds these into `initObservability` (`./sdk`) — the slice itself stays
 * SDK-free so the facade entry's dependency posture is unchanged.
 */
export const configSlice = defineConfigSlice('observability', (mode) =>
  z.object({
    OTEL_EXPORTER_OTLP_ENDPOINT: (isFailClosed(mode)
      ? z.url()
      : z.url().default('http://localhost:4318')
    ).describe('Live-required. OTLP-HTTP base endpoint; default targets the compose otel-lgtm.'),
    OTEL_SERVICE_NAME: z
      .string()
      .min(1)
      .default('api')
      .describe('Service resource attribute: service name.'),
    OTEL_SERVICE_NAMESPACE: z
      .string()
      .min(1)
      .default('reviews')
      .describe('Service resource attribute: service namespace.'),
    DEPLOYMENT_ENVIRONMENT: (isFailClosed(mode)
      ? z.string().min(1)
      : z.string().min(1).default('dev')
    ).describe('Live-required; e.g. dev, staging, prod.'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug'])
      .default('info')
      .describe('One of: fatal | error | warn | info | debug (no trace level).'),
  }),
);

/** The parsed output of {@link configSlice} (ADR-0003): the app composes its config shape
 * from this exported type rather than restating the field list by hand. */
export type ObservabilitySliceConfig = z.infer<ReturnType<typeof configSlice.schema>>;
