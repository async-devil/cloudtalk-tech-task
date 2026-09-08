// Public barrel — the module's entire public contract (ADR-0003: one barrel, no nested barrels).
export { type ComposedConfig, ConfigError, composeConfig } from './compose.js';
export { APP_MODE, APP_MODES, type AppMode, isFailClosed, readAppMode } from './mode.js';
export {
  type EnvDocumentationEntry,
  type EnvDocumentationSection,
  renderEnvExample,
} from './render-env-example.js';
export { type ConfigSlice, defineConfigSlice } from './slice.js';
export { type ConfigSource, envFileSource, processEnvSource } from './sources.js';
