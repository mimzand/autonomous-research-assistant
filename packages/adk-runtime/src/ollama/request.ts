import {
  type GenerateRequest,
  type GenerationOptions,
  type ResponseFormat,
  type ToolDefinition,
} from '@rka/model-provider';
import {
  type BaseTool,
  type GenaiSchema,
  type GenerateContentConfig,
  type LlmRequest,
} from '../adk.js';
import { ADAPTER_ERROR_CODES, AdkConversionError } from './errors.js';
import { toChatMessages } from './messages.js';
import { genaiSchemaToJsonSchema, isZodSchema, zodToJsonSchema } from './schema.js';

/*
 * ADK `LlmRequest` → provider `GenerateRequest`.
 *
 * Generation config mapping (GenAI → provider → Ollama option):
 *   temperature → temperature, topP → top_p, topK → top_k,
 *   maxOutputTokens → num_predict, stopSequences → stop, seed → seed,
 *   thinkingConfig → think (off when thinkingBudget is 0, on when
 *   includeThoughts, a positive budget or a thinking level is set),
 *   httpOptions.timeout → request timeout.
 * Context size comes from the provider's runtime configuration (num_ctx) or
 * the adapter's `contextLength` option; GenAI has no such field.
 *
 * Settings Ollama cannot honour are rejected instead of ignored
 * (OLLAMA_UNSUPPORTED_CONFIG): candidateCount > 1, penalties, log-probs,
 * safety settings, cached content, response modalities, tool config, custom
 * HTTP base URL / headers / fetch, and every other field not listed here.
 * `labels` (request metadata) is accepted and not sent.
 */

const MAPPED_KEYS = new Set([
  'temperature',
  'topP',
  'topK',
  'maxOutputTokens',
  'stopSequences',
  'seed',
  'thinkingConfig',
  'httpOptions',
  'systemInstruction',
  'tools',
  'responseMimeType',
  'responseSchema',
  'responseJsonSchema',
  'candidateCount',
  'labels',
  'abortSignal',
]);

function unsupportedConfig(message: string): never {
  throw new AdkConversionError(ADAPTER_ERROR_CODES.unsupportedConfig, message);
}

export interface ConvertedRequest {
  readonly request: GenerateRequest;
  /** Request timeout from `httpOptions.timeout`, if set. */
  readonly timeoutMs?: number;
  /** Whether the response must be JSON (structured output). */
  readonly structured: boolean;
}

export interface ConvertOptions {
  readonly model: string;
  readonly contextLength?: number;
}

export function toGenerateRequest(
  llmRequest: LlmRequest,
  options: ConvertOptions,
): ConvertedRequest {
  const config: GenerateContentConfig = llmRequest.config ?? {};
  for (const [key, value] of Object.entries(config)) {
    if (value !== undefined && !MAPPED_KEYS.has(key)) {
      unsupportedConfig(`Generation setting "${key}" is not supported by Ollama.`);
    }
  }
  if (config.candidateCount !== undefined && config.candidateCount !== 1) {
    unsupportedConfig('Ollama returns one candidate per request (candidateCount must be 1).');
  }

  let timeoutMs: number | undefined;
  if (config.httpOptions) {
    const { timeout, ...rest } = config.httpOptions;
    const others = Object.entries(rest)
      .filter(([, v]) => v !== undefined)
      .map(([k]) => k);
    if (others.length > 0) {
      unsupportedConfig(
        `httpOptions.${others.join(', ')} cannot be set: the Ollama connection is configured in Settings.`,
      );
    }
    timeoutMs = timeout;
  }

  const generation: GenerationOptions = {
    ...(config.temperature !== undefined && { temperature: config.temperature }),
    ...(config.topP !== undefined && { topP: config.topP }),
    ...(config.topK !== undefined && { topK: config.topK }),
    ...(config.maxOutputTokens !== undefined && { maxTokens: config.maxOutputTokens }),
    ...(config.stopSequences !== undefined && { stop: config.stopSequences }),
    ...(config.seed !== undefined && { seed: config.seed }),
    ...(options.contextLength !== undefined && { contextLength: options.contextLength }),
  };

  const tools = toToolDefinitions(llmRequest);
  const responseFormat = toResponseFormat(config);

  const request: GenerateRequest = {
    model: options.model,
    messages: toChatMessages(llmRequest.contents, config.systemInstruction),
    ...(Object.keys(generation).length > 0 && { options: generation }),
    think: toThink(config.thinkingConfig),
    ...(tools.length > 0 && { tools }),
    ...(responseFormat && { responseFormat }),
  };
  return {
    request,
    ...(timeoutMs !== undefined && { timeoutMs }),
    structured: responseFormat !== undefined,
  };
}

function toThink(thinking: GenerateContentConfig['thinkingConfig']): boolean {
  if (!thinking) return false;
  if (thinking.thinkingBudget === 0) return false;
  return Boolean(
    thinking.includeThoughts || (thinking.thinkingBudget ?? 0) > 0 || thinking.thinkingLevel,
  );
}

function toResponseFormat(config: GenerateContentConfig): ResponseFormat | undefined {
  const mime = config.responseMimeType;
  if (mime !== undefined && mime !== 'application/json' && mime !== 'text/plain') {
    unsupportedConfig(`Response type "${mime}" is not supported.`);
  }
  // A JSON Schema set directly (e.g. derived from Zod) wins over the lossy GenAI schema.
  if (config.responseJsonSchema !== undefined) {
    const schema = config.responseJsonSchema;
    if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
      throw new AdkConversionError(
        ADAPTER_ERROR_CODES.schemaConversion,
        'responseJsonSchema must be a JSON Schema object.',
      );
    }
    return { type: 'json_schema', schema: schema as Record<string, unknown> };
  }
  if (config.responseSchema !== undefined) {
    return {
      type: 'json_schema',
      schema: genaiSchemaToJsonSchema(config.responseSchema as GenaiSchema),
    };
  }
  if (mime === 'application/json') return { type: 'json' };
  return undefined;
}

/**
 * Function declarations → provider tool definitions. Parameters come, in
 * order of preference, from the declaration's JSON Schema, the tool's own Zod
 * schema (ADK FunctionTool), or the converted GenAI schema.
 */
function toToolDefinitions(llmRequest: LlmRequest): ToolDefinition[] {
  const definitions: ToolDefinition[] = [];
  for (const tool of llmRequest.config?.tools ?? []) {
    const entry = tool as Record<string, unknown>;
    const kinds = Object.keys(entry).filter((k) => entry[k] !== undefined);
    if (kinds.some((k) => k !== 'functionDeclarations')) {
      unsupportedConfig(
        `Tool type "${kinds.join(', ')}" is not supported: only function declarations are.`,
      );
    }
    const declarations = (entry['functionDeclarations'] ?? []) as {
      name?: string;
      description?: string;
      parameters?: GenaiSchema;
      parametersJsonSchema?: unknown;
    }[];
    for (const declaration of declarations) {
      const name = declaration.name ?? '';
      const own = (llmRequest.toolsDict[name] as (BaseTool & { parameters?: unknown }) | undefined)
        ?.parameters;
      let parameters: Record<string, unknown>;
      if (declaration.parametersJsonSchema !== undefined) {
        parameters = declaration.parametersJsonSchema as Record<string, unknown>;
      } else if (isZodSchema(own)) {
        parameters = zodToJsonSchema(own);
      } else if (declaration.parameters) {
        parameters = genaiSchemaToJsonSchema(declaration.parameters, `tool ${name}`);
      } else {
        parameters = { type: 'object', properties: {} };
      }
      definitions.push({ name, description: declaration.description?.trim() || name, parameters });
    }
  }
  return definitions;
}
