/**
 * Minimal hand-written ambient declarations for the runtime surfaces this package uses beyond
 * its typed dependencies. No `@types/node` (no registry entry); declare-only-what-you-use, same
 * pattern as `packages/config/src/ambient.d.ts`. node:* usage in backend packages is sanctioned
 * in `biome.jsonc`.
 */
declare module 'node:process' {
  const process: {
    readonly stdout: { readonly isTTY?: boolean };
  };
  export default process;
}

/** Web Crypto is a Bun/Node global (used for `service.instance.id`); only randomUUID is needed. */
declare const crypto: {
  randomUUID(): string;
};
