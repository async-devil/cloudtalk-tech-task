/**
 * Hand-written type declarations for `data-lifecycle-registry.cjs` (TypeScript's `.d.cts`
 * extension-specific declaration form — mirrors `module-registry.d.cts` exactly). Keep in sync
 * with the runtime file by hand; the one consumer (`migration-ddl.ts`) makes drift easy to catch
 * in review.
 */

export type LifecycleClass = 'reference' | 'truth' | 'evidence' | 'projection';

export const LIFECYCLE_CLASS: {
  readonly Reference: 'reference';
  readonly Truth: 'truth';
  readonly Evidence: 'evidence';
  readonly Projection: 'projection';
};

export interface LifecycleRegistryRow {
  readonly class: LifecycleClass;
  readonly horizon?: string;
}

export const REGISTRY: Readonly<Record<string, LifecycleRegistryRow>>;
