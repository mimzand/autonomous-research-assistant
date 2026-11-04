import { z } from 'zod';

/** Health of the local model server, as reported to the UI. */
export const ModelHealthSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ready'),
    provider: z.literal('ollama'),
    baseUrl: z.string(),
    serverVersion: z.string(),
    model: z.string(),
  }),
  z.object({
    status: z.literal('model-missing'),
    provider: z.literal('ollama'),
    baseUrl: z.string(),
    serverVersion: z.string(),
    model: z.string(),
    installedModels: z.array(z.string()),
  }),
  z.object({
    status: z.literal('unreachable'),
    provider: z.literal('ollama'),
    baseUrl: z.string(),
    model: z.string(),
    error: z.string(),
  }),
]);

export type ModelHealth = z.infer<typeof ModelHealthSchema>;
