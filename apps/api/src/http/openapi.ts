import {
  type ConditionalSchemaConverter,
  type JSONSchema,
  type OpenAPI,
  OpenAPIGenerator,
} from '@orpc/openapi';
import { appContract } from '@repo/contracts';
import { z } from 'zod';

/**
 * The zod-v4-native schema converter oRPC's `OpenAPIGenerator` needs to understand this
 * workspace's contract schemas at all (ADR-0004: "the same contract produces the OpenAPI
 * document, so the document cannot drift from the handlers"). `@orpc/openapi` ships no zod
 * converter of its own, and there is no `@orpc/zod` package pinned in this workspace's lockfile —
 * adding one would be a new dependency for a result zod v4 already gives for free: it ships its
 * own `toJSONSchema` (`node_modules/zod/v4/core/json-schema-processors.d.ts`), so wrapping that is
 * strictly less than a new dependency would cost, for the identical output. Verified, not
 * assumed: with NO converter registered, `OpenAPIGenerator.generate` throws
 * `OpenAPIGeneratorError` for every route carrying a path parameter (`products.get`,
 * `reviews.listForProduct`, `reviews.submit`, `reviews.update`, `reviews.remove`) — "input schema
 * must be an object with all dynamic params as required" — because the generator cannot recognise
 * an unconverted schema as an object at all.
 */
export const zodSchemaConverter: ConditionalSchemaConverter = {
  condition: (schema) => schema instanceof z.ZodType,
  convert: (schema, options) => {
    if (schema === undefined) {
      return [false, {}];
    }
    const jsonSchema = z.toJSONSchema(schema as z.ZodType, {
      target: 'openapi-3.0',
      io: options.strategy,
      // `unrepresentable: 'any'` rather than the default `'throw'`: this contract's schemas are
      // built for runtime validation, not documentation, and a shape zod cannot express in JSON
      // Schema (there are none known in this contract today, but a future one is not a boot
      // failure this generator should own) degrades to `{}` for that one field rather than
      // failing document generation entirely.
      unrepresentable: 'any',
    });
    // `z.toJSONSchema`'s return type and `@orpc/openapi`'s own `JSONSchema` type are two separate
    // nominal interfaces for the identical JSON Schema draft-2020-12 vocabulary (each package
    // declares its own generic instantiation of a third-party `json-schema-typed` type, which is
    // where the structural mismatch TS reports actually comes from) — a documented
    // structural-equivalence claim, not an unsafe widening (ADR-0003 constraint): both are plain
    // JSON values at runtime, and `test/openapi.test.ts` proves the values this cast lets through
    // are well-formed by running the whole generator against the real contract and asserting on
    // its output, not merely on this function typechecking.
    return [true, jsonSchema as unknown as JSONSchema];
  },
};

/**
 * Builds the OpenAPI document `appContract` describes (ADR-0004): generated, never hand-written,
 * so it cannot drift from what the handlers actually implement. Exported for
 * `test/openapi.test.ts`'s "every route, every error shape" proof (TASK-0003's acceptance
 * criterion) and for any future consumer that wants the real document (a CLI script, a served
 * `/openapi.json` route) without re-deriving how to wire the generator.
 */
export function createOpenApiDocument(): Promise<OpenAPI.Document> {
  const generator = new OpenAPIGenerator({ schemaConverters: [zodSchemaConverter] });
  return generator.generate(appContract, {
    info: { title: '@repo/api', version: '0.0.0' },
  });
}
