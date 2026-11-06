import { z } from 'zod';

/*
 * Provider-neutral request/response contract. Nothing here is Ollama-specific;
 * provider implementations translate to and from their own wire format.
 */

export const ChatMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const ResponseFormatSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text') }),
  /** Any valid JSON. */
  z.object({ type: z.literal('json') }),
  /** JSON constrained by a JSON Schema. */
  z.object({ type: z.literal('json_schema'), schema: z.record(z.string(), z.unknown()) }),
]);
export type ResponseFormat = z.infer<typeof ResponseFormatSchema>;

export const GenerationOptionsSchema = z.strictObject({
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().gt(0).max(1).optional(),
  /** Only the K most likely tokens are considered. */
  topK: z.int().min(1).max(1000).optional(),
  /** Penalises repeated tokens (1 = off). */
  repeatPenalty: z.number().min(0).max(2).optional(),
  seed: z.int().optional(),
  /** Maximum tokens to generate. */
  maxTokens: z.int().positive().optional(),
  /** Context window in tokens. Defaults to the provider's configured value. */
  contextLength: z.int().min(512).max(1_048_576).optional(),
  stop: z.array(z.string().min(1)).max(8).optional(),
});
export type GenerationOptions = z.infer<typeof GenerationOptionsSchema>;

export const GenerateRequestSchema = z.strictObject({
  /** Defaults to the provider's configured model. */
  model: z.string().trim().min(1).optional(),
  messages: z.array(ChatMessageSchema).min(1),
  responseFormat: ResponseFormatSchema.optional(),
  options: GenerationOptionsSchema.optional(),
  /** Enable model "thinking" output. Off by default; only some models support it. */
  think: z.boolean().optional(),
});
export type GenerateRequest = z.input<typeof GenerateRequestSchema>;

export type FinishReason = 'stop' | 'length' | 'other';

export interface Usage {
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly totalDurationMs: number | null;
  readonly loadDurationMs: number | null;
}

export interface GenerateResult {
  readonly model: string;
  readonly content: string;
  /** Present only when thinking was requested and returned. */
  readonly thinking?: string;
  readonly finishReason: FinishReason;
  readonly usage: Usage;
}

export type GenerateChunk =
  | { readonly type: 'delta'; readonly content: string; readonly thinking?: string }
  | { readonly type: 'done'; readonly result: GenerateResult };

export interface CallOptions {
  /** Abort to cancel. Surfaces as a `cancelled` error. */
  readonly signal?: AbortSignal;
  /** Overall deadline. Surfaces as a `timeout` error. */
  readonly timeoutMs?: number;
  /** Streams only: maximum silence between chunks. Surfaces as a `timeout` error. */
  readonly idleTimeoutMs?: number;
}

export interface ModelInfo {
  readonly name: string;
  readonly capabilities: readonly string[];
  readonly contextLength: number | null;
  readonly parameterSize: string | null;
  readonly quantization: string | null;
}

export type ModelAvailability =
  | { readonly available: true; readonly model: ModelInfo }
  | {
      readonly available: false;
      readonly requested: string;
      readonly installedModels: readonly string[];
    };
