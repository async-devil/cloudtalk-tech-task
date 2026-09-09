import { type AuthSliceConfig, authConfigSlice } from '@repo/auth';
import { type MessagingSliceConfig, configSlice as messagingConfigSlice } from '@repo/messaging';
import {
  type ObservabilitySliceConfig,
  configSlice as observabilityConfigSlice,
} from '@repo/observability';
import {
  type PersistenceSliceConfig,
  configSlice as persistenceConfigSlice,
} from '@repo/persistence';
import { type ApiSliceConfig, apiConfigSlice } from './api-slice.js';

/**
 * The composed shape for the app's config slices, assembled from each slice's exported
 * parsed-output type — no field list is restated here, so the composed shape can never drift from
 * what the slices actually parse.
 */
export interface AppConfig {
  readonly api: ApiSliceConfig;
  readonly observability: ObservabilitySliceConfig;
  readonly persistence: PersistenceSliceConfig;
  readonly messaging: MessagingSliceConfig;
  readonly auth: AuthSliceConfig;
}

/** Slices composed at boot, in the order the report lists them. */
export const APP_CONFIG_SLICES = [
  apiConfigSlice,
  observabilityConfigSlice,
  persistenceConfigSlice,
  messagingConfigSlice,
  authConfigSlice,
] as const;

export { apiConfigSlice };
