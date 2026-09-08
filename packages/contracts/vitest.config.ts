import { defineConfig } from 'vitest/config';

// This package ships type-level contracts with no runtime behavior of their own to unit-test
// (apiErrorShape is exercised indirectly by the HTTP boundary's error-mapping tests; the mail
// ports are exercised end to end by the auth module's test-integration suite). `passWithNoTests`
// keeps this task green until a contract with its own runtime logic lands here.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    passWithNoTests: true,
  },
});
