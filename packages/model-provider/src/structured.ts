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

  const json = extractJson(result.content);
  if (json === undefined) {
    throw new ModelProviderError(
      'invalid-response',
      `Model did not return valid JSON (got: ${JSON.stringify(result.content.slice(0, 200))}).`,
    );
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

/**
 * Parses the model's JSON, tolerating common wrappers small local models add
 * even in JSON mode: a <think>…</think> block, Markdown code fences, or text
 * before/after the object. Returns undefined when no JSON can be recovered.
 * The result is still validated against the schema by the caller.
 */
export function extractJson(content: string): unknown {
  const attempts: string[] = [];
  const text = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  attempts.push(text);
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced?.[1]) attempts.push(fenced[1].trim());
  const first = text.search(/[{[]/);
  const last = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
  if (first >= 0 && last > first) attempts.push(text.slice(first, last + 1));
  for (const candidate of attempts) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}

/** JSON Schema for the model. `$schema` is dropped: it is metadata the model does not need. */
export function toModelJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}
