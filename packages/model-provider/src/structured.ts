import { z } from 'zod';
import { ModelProviderError } from './errors.js';
import { type ModelProvider } from './provider.js';
import { type CallOptions, type GenerateRequest, type GenerateResult } from './schemas.js';

export interface StructuredResult<T> {
  readonly object: T;
  readonly result: GenerateResult;
}

/**
 * Generates JSON constrained by a Zod schema and validates the reply.
 * The schema is sent to the model as a JSON Schema; the model's output is
 * still treated as untrusted and parsed with Zod.
 *
 * Throws `invalid-response` if the output is not valid JSON or does not
 * match the schema, and `unsupported` if the server cannot constrain output.
 */
export async function generateObject<Schema extends z.ZodType>(
  provider: ModelProvider,
  request: Omit<GenerateRequest, 'responseFormat'>,
  schema: Schema,
  options?: CallOptions,
): Promise<StructuredResult<z.output<Schema>>> {
  const result = await provider.generate(
    { ...request, responseFormat: { type: 'json_schema', schema: toModelJsonSchema(schema) } },
    options,
  );

  let json: unknown;
  try {
    json = JSON.parse(result.content);
  } catch (cause) {
    throw new ModelProviderError('invalid-response', 'Model did not return valid JSON.', { cause });
  }

  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new ModelProviderError(
      'invalid-response',
      `Model output does not match the schema: ${parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ')}`,
      { cause: parsed.error },
    );
  }
  return { object: parsed.data, result };
}

/** JSON Schema for the model. `$schema` is dropped: it is metadata the model does not need. */
export function toModelJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}
