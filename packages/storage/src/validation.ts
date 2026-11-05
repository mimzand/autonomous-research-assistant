import { z } from 'zod';
import { StorageError } from './errors.js';
import { type JsonValue } from './schema.js';

/** Any JSON-serialisable value (no undefined, functions, Dates, NaN...). */
export const JsonValueSchema = z.json() as z.ZodType<JsonValue>;

/** Parses repository input; throws StorageError('invalid-input') with readable issues. */
export function parseInput<S extends z.ZodType>(
  schema: S,
  value: unknown,
  what: string,
): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new StorageError(
      'invalid-input',
      `Invalid ${what}: ${result.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ')}`,
      { cause: result.error },
    );
  }
  return result.data;
}

export const IdSchema = z.string().min(1).max(100);
