import { extractJson, toModelJsonSchema } from '@rka/model-provider';
import { type z } from 'zod';
import { type Event, type LlmRequest } from './adk.js';

/*
 * Structured output through ADK, validated by the app.
 *
 * ADK's own outputSchema handling only logs invalid output and still stores
 * it (`outputKey` state). The app therefore never trusts ADK for this:
 * - the JSON Schema sent to Ollama is derived from the Zod schema (lossless),
 * - the final model text is parsed with the provider's JSON extraction and
 *   validated with the same Zod schema here, at the application boundary,
 * - agents may not use `outputKey` (the agent guard rejects it).
 */

export type StructuredParseResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

export interface StructuredOutput<S extends z.ZodType> {
  /** JSON Schema for the model, derived from the Zod schema. */
  readonly jsonSchema: Record<string, unknown>;
  /** ADK beforeModelCallback: asks the model for JSON matching `jsonSchema`. */
  readonly beforeModelCallback: (args: { request: LlmRequest }) => undefined;
  /** Validates the model's final text. The only way a structured result is accepted. */
  parse(text: string | undefined): StructuredParseResult<z.output<S>>;
}

export function structuredOutput<S extends z.ZodType>(schema: S): StructuredOutput<S> {
  const jsonSchema = toModelJsonSchema(schema);
  return {
    jsonSchema,
    beforeModelCallback: ({ request }) => {
      request.config ??= {};
      request.config.responseJsonSchema = jsonSchema;
      request.config.responseMimeType = 'application/json';
      delete request.config.responseSchema;
      return undefined;
    },
    parse(text) {
      if (text === undefined || text.trim() === '')
        return { ok: false, error: 'The model returned no output.' };
      const json = extractJson(text);
      if (json === undefined) return { ok: false, error: 'The model output is not valid JSON.' };
      const parsed = schema.safeParse(json);
      if (!parsed.success) {
        return {
          ok: false,
          error: `The model output does not match the schema: ${parsed.error.issues
            .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
            .join('; ')}`,
        };
      }
      return { ok: true, value: parsed.data };
    },
  };
}

/**
 * The text of the last complete (non-partial) model response in a run,
 * without thought parts. Undefined if the run ended with an error or abort.
 */
export function finalResponseText(events: readonly Event[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (!event || event.partial) continue;
    if (event.errorCode) return undefined;
    const parts = event.content?.parts ?? [];
    if (
      event.content?.role === 'model' &&
      parts.some((p) => typeof p.text === 'string' && !p.thought)
    ) {
      return parts
        .filter((p) => typeof p.text === 'string' && !p.thought)
        .map((p) => p.text)
        .join('');
    }
  }
  return undefined;
}
