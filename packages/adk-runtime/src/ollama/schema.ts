import { toModelJsonSchema } from '@rka/model-provider';
import { type GenaiSchema } from '../adk.js';
import { ADAPTER_ERROR_CODES, AdkConversionError } from './errors.js';

/*
 * Schema conversion: Google GenAI `Schema` (what ADK puts on requests) →
 * JSON Schema (what Ollama's `format` and `tools[].function.parameters` take).
 *
 * ADK derives the GenAI schema from Zod through an OpenAPI 3.0 conversion that
 * loses `additionalProperties` and turns numeric limits into strings. Where the
 * original Zod schema is available it is used instead (`zodToJsonSchema`), so
 * the Zod schema stays the authoritative definition. The GenAI conversion is
 * the fallback and fails loudly on anything it cannot represent.
 */

const TYPES: Readonly<Record<string, string>> = {
  STRING: 'string',
  NUMBER: 'number',
  INTEGER: 'integer',
  BOOLEAN: 'boolean',
  ARRAY: 'array',
  OBJECT: 'object',
  NULL: 'null',
};

/** Non-validating annotations the model does not need. */
const DROPPED_KEYS = new Set(['example', 'propertyOrdering']);

const STRING_INTEGER_KEYS = [
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'minProperties',
  'maxProperties',
] as const;

function fail(path: string, message: string): never {
  throw new AdkConversionError(
    ADAPTER_ERROR_CODES.schemaConversion,
    `Schema ${path || '(root)'}: ${message}`,
  );
}

function toInteger(value: unknown, path: string, key: string): number {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) {
    fail(path, `"${key}" must be a non-negative integer (got ${JSON.stringify(value)}).`);
  }
  return n;
}

/** Converts a GenAI schema to JSON Schema. Throws AdkConversionError on unsupported input. */
export function genaiSchemaToJsonSchema(schema: GenaiSchema, path = ''): Record<string, unknown> {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    fail(path, 'expected an object.');
  }
  const source = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || DROPPED_KEYS.has(key)) continue;
    switch (key) {
      case 'type': {
        if (typeof value !== 'string') fail(path, '"type" must be a string.');
        if (value === 'TYPE_UNSPECIFIED') break;
        const mapped = TYPES[value.toUpperCase()];
        if (!mapped) fail(path, `unsupported type "${value}".`);
        out['type'] = mapped;
        break;
      }
      case 'nullable':
        if (typeof value !== 'boolean') fail(path, '"nullable" must be a boolean.');
        break; // applied below
      case 'properties': {
        if (typeof value !== 'object' || value === null)
          fail(path, '"properties" must be an object.');
        out['properties'] = Object.fromEntries(
          Object.entries(value as Record<string, GenaiSchema>).map(([name, sub]) => [
            name,
            genaiSchemaToJsonSchema(sub, `${path}.properties.${name}`),
          ]),
        );
        break;
      }
      case 'items':
        out['items'] = genaiSchemaToJsonSchema(value as GenaiSchema, `${path}.items`);
        break;
      case 'anyOf':
      case 'allOf':
      case 'oneOf':
        if (!Array.isArray(value) || value.length === 0)
          fail(path, `"${key}" must be a non-empty array.`);
        out[key] = value.map((sub, i) =>
          genaiSchemaToJsonSchema(sub as GenaiSchema, `${path}.${key}[${i}]`),
        );
        break;
      case 'required':
        if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
          fail(path, '"required" must be an array of strings.');
        }
        out['required'] = [...value];
        break;
      case 'enum':
        if (!Array.isArray(value) || value.length === 0)
          fail(path, '"enum" must be a non-empty array.');
        out['enum'] = [...value];
        break;
      case 'minimum':
      case 'maximum':
      case 'multipleOf':
        if (typeof value !== 'number' || !Number.isFinite(value))
          fail(path, `"${key}" must be a number.`);
        out[key] = value;
        break;
      case 'exclusiveMinimum':
      case 'exclusiveMaximum':
        // OpenAPI 3.0: boolean modifying minimum/maximum. JSON Schema: the bound itself.
        if (typeof value === 'number') out[key] = value;
        else if (typeof value !== 'boolean') fail(path, `"${key}" must be a boolean or number.`);
        break;
      case 'pattern':
      case 'format':
      case 'description':
      case 'title':
        if (typeof value !== 'string') fail(path, `"${key}" must be a string.`);
        out[key] = value;
        break;
      case 'default':
      case 'const':
        out[key] = value;
        break;
      default:
        if ((STRING_INTEGER_KEYS as readonly string[]).includes(key)) {
          out[key] = toInteger(value, path, key);
        } else {
          fail(path, `unsupported keyword "${key}".`);
        }
    }
  }

  // OpenAPI boolean exclusive bounds → JSON Schema numeric bounds.
  for (const [flag, bound] of [
    ['exclusiveMinimum', 'minimum'],
    ['exclusiveMaximum', 'maximum'],
  ] as const) {
    if (source[flag] === true) {
      if (typeof out[bound] !== 'number') fail(path, `"${flag}" needs "${bound}".`);
      out[flag] = out[bound];
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- bound is 'minimum' or 'maximum'
      delete out[bound];
    }
  }

  if (source['nullable'] === true) {
    const type = out['type'];
    if (typeof type === 'string') out['type'] = type === 'null' ? 'null' : [type, 'null'];
    else return { anyOf: [out, { type: 'null' }] };
  }

  if (
    out['type'] === undefined &&
    !out['anyOf'] &&
    !out['allOf'] &&
    !out['oneOf'] &&
    out['enum'] === undefined &&
    !('const' in out)
  ) {
    fail(path, 'has no type.');
  }
  if (out['type'] === 'array' && out['items'] === undefined) fail(path, 'array without "items".');
  return out;
}

/** True for a Zod (v4) schema object. */
export function isZodSchema(value: unknown): value is Parameters<typeof toModelJsonSchema>[0] {
  return (
    typeof value === 'object' &&
    value !== null &&
    '_zod' in value &&
    typeof (value as { safeParse?: unknown }).safeParse === 'function'
  );
}

/** JSON Schema from the authoritative Zod schema (keeps additionalProperties and numeric limits). */
export function zodToJsonSchema(
  schema: Parameters<typeof toModelJsonSchema>[0],
): Record<string, unknown> {
  return toModelJsonSchema(schema);
}
