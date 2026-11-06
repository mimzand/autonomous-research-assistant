import { z } from 'zod';

/** Why the model server could not be used. */
export const ModelUnavailableReasonSchema = z.enum([
  'unavailable',
  'timeout',
  'invalid-response',
  'http-error',
  /** The user disconnected from Ollama in Settings. */
  'disconnected',
]);
export type ModelUnavailableReason = z.infer<typeof ModelUnavailableReasonSchema>;

const HealthBase = z.object({
  provider: z.literal('ollama'),
  baseUrl: z.string(),
  model: z.string(),
  checkedAt: z.iso.datetime(),
});

/** Health of the local model server, as reported to the UI. */
export const ModelHealthSchema = z.discriminatedUnion('status', [
  HealthBase.extend({
    status: z.literal('ready'),
    serverVersion: z.string(),
    /** Capabilities reported by the server for this model, e.g. completion, tools, thinking. */
    capabilities: z.array(z.string()),
    contextLength: z.number().int().positive().nullable(),
    /** JSON-schema constrained output (Ollama >= 0.5.0). */
    structuredOutput: z.boolean(),
  }),
  HealthBase.extend({
    status: z.literal('model-missing'),
    serverVersion: z.string(),
    installedModels: z.array(z.string()),
  }),
  HealthBase.extend({
    status: z.literal('unreachable'),
    reason: ModelUnavailableReasonSchema,
    error: z.string(),
  }),
]);

export type ModelHealth = z.infer<typeof ModelHealthSchema>;
