import { z } from 'zod';

/*
 * Ollama HTTP API response shapes (verified against Ollama 0.40.14).
 * Only fields we rely on are declared; unknown fields are ignored so newer
 * server versions keep working.
 */

export const OllamaVersionSchema = z.object({ version: z.string().min(1) });

const OllamaModelDetailsSchema = z.object({
  format: z.string().optional(),
  family: z.string().optional(),
  families: z.array(z.string()).nullable().optional(),
  parameter_size: z.string().optional(),
  quantization_level: z.string().optional(),
  context_length: z.number().int().positive().optional(),
});

export const OllamaTagsSchema = z.object({
  models: z.array(
    z.object({
      name: z.string().min(1),
      modified_at: z.string().optional(),
      size: z.number().int().nonnegative().optional(),
      digest: z.string().optional(),
      details: OllamaModelDetailsSchema.optional(),
      /** Present in recent Ollama versions. */
      capabilities: z.array(z.string()).optional(),
    }),
  ),
});
export type OllamaTags = z.infer<typeof OllamaTagsSchema>;

/** POST /api/show. Only the fields shown in Settings; the rest is ignored. */
export const OllamaShowSchema = z.object({
  details: OllamaModelDetailsSchema.optional(),
  capabilities: z.array(z.string()).optional(),
  model_info: z.record(z.string(), z.unknown()).optional(),
  parameters: z.string().optional(),
  license: z.string().optional(),
  modified_at: z.string().optional(),
});
export type OllamaShow = z.infer<typeof OllamaShowSchema>;

export const OllamaErrorBodySchema = z.object({ error: z.string() });

const nonNegativeInt = z.number().int().nonnegative();

/**
 * One tool call as Ollama reports it in `message.tool_calls`. Only the shape
 * is checked here; names and arguments are validated by the provider, so one
 * bad call is reported as invalid instead of failing the whole response.
 * - `id`: sent by newer servers only.
 * - `function.index`: position of the call; newer servers only.
 * - `function.arguments`: a JSON object in the native API. A JSON string is
 *   tolerated (some model templates produce one).
 */
export const OllamaToolCallSchema = z.object({
  id: z.string().optional(),
  type: z.string().optional(),
  function: z.object({
    index: z.number().int().nonnegative().optional(),
    name: z.string(),
    arguments: z.unknown(),
  }),
});
export type OllamaToolCall = z.infer<typeof OllamaToolCallSchema>;

export const OllamaChatChunkSchema = z.object({
  model: z.string(),
  message: z.object({
    role: z.literal('assistant'),
    content: z.string(),
    thinking: z.string().optional(),
    tool_calls: z.array(OllamaToolCallSchema).nullable().optional(),
  }),
  done: z.boolean(),
  done_reason: z.string().optional(),
  prompt_eval_count: nonNegativeInt.optional(),
  eval_count: nonNegativeInt.optional(),
  total_duration: nonNegativeInt.optional(),
  load_duration: nonNegativeInt.optional(),
});
export type OllamaChatChunk = z.infer<typeof OllamaChatChunkSchema>;

/** Body for POST /api/chat. */
/** A tool call replayed in an assistant message of the conversation history. */
export interface OllamaWireToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: Record<string, unknown> };
}

export type OllamaWireMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; tool_calls?: OllamaWireToolCall[] }
  /** `tool_name` is matched by every tool-capable server; `tool_call_id` by newer ones. */
  | { role: 'tool'; content: string; tool_name: string; tool_call_id: string };

/** Ollama tool definition (`tools` in POST /api/chat). */
export interface OllamaWireTool {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface OllamaChatBody {
  model: string;
  messages: OllamaWireMessage[];
  tools?: OllamaWireTool[];
  stream: boolean;
  think: boolean;
  format?: 'json' | Record<string, unknown>;
  options: {
    num_ctx: number;
    temperature?: number;
    top_p?: number;
    top_k?: number;
    repeat_penalty?: number;
    seed?: number;
    num_predict?: number;
    stop?: string[];
  };
}
