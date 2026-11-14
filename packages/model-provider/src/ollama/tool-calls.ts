import {
  type ChatMessage,
  type InvalidToolCall,
  type ToolCall,
  type ToolDefinition,
} from '../schemas.js';
import { truncate } from './ndjson.js';
import { type OllamaToolCall, type OllamaWireMessage, type OllamaWireTool } from './wire.js';

/*
 * Translation between the provider-neutral tool-calling contract and Ollama's
 * native /api/chat format. Pure functions: nothing here executes a tool.
 */

/**
 * First Ollama version whose /api/chat accepts `tools` (0.3.0). Streaming
 * tool calls arrived later (0.8.0); older servers deliver tool calls in a
 * single chunk, which the collector below handles the same way.
 */
export const TOOL_CALLING_MIN_VERSION: readonly [number, number, number] = [0, 3, 0];

export function toWireTools(tools: readonly ToolDefinition[]): OllamaWireTool[] {
  return tools.map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
}

export function toWireMessage(message: ChatMessage): OllamaWireMessage {
  switch (message.role) {
    case 'system':
    case 'user':
      return { role: message.role, content: message.content };
    case 'assistant':
      return message.toolCalls?.length
        ? {
            role: 'assistant',
            content: message.content,
            tool_calls: message.toolCalls.map((call) => ({
              id: call.id,
              type: 'function',
              function: { name: call.name, arguments: call.arguments },
            })),
          }
        : { role: 'assistant', content: message.content };
    case 'tool':
      return {
        role: 'tool',
        content: message.content,
        tool_name: message.name,
        tool_call_id: message.toolCallId,
      };
  }
}

/** True when the request or its history uses tool calling. */
export function usesToolCalling(messages: readonly ChatMessage[], tools: unknown): boolean {
  return (
    tools !== undefined ||
    messages.some((m) => m.role === 'tool' || (m.role === 'assistant' && !!m.toolCalls?.length))
  );
}

type ParsedArguments =
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly message: string };

/**
 * Tool arguments must be a JSON object. Ollama sends an object; a JSON string
 * holding an object is accepted too. Anything else is malformed.
 */
export function parseToolArguments(raw: unknown): ParsedArguments {
  let value = raw;
  if (raw === undefined || raw === null) return { ok: true, value: {} };
  if (typeof raw === 'string') {
    if (raw.trim() === '') return { ok: true, value: {} };
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      return { ok: false, message: 'Arguments are not valid JSON.' };
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, message: 'Arguments must be a JSON object.' };
  }
  return { ok: true, value: value as Record<string, unknown> };
}

const describeRaw = (raw: unknown): string => {
  try {
    return truncate(typeof raw === 'string' ? raw : (JSON.stringify(raw) ?? String(raw)), 500);
  } catch {
    return '[unserialisable]';
  }
};

export interface CollectedToolCalls {
  readonly toolCalls: ToolCall[];
  readonly invalidToolCalls: InvalidToolCall[];
}

/**
 * Accumulates tool calls over a (possibly streamed) response and validates
 * them once the response is complete:
 * - calls are kept in arrival order; a later entry with the same `index`
 *   replaces the earlier one (a server that re-sends a call as it completes),
 * - every call gets a unique id (the server's when present, else generated),
 * - names must be declared tools; arguments must be a JSON object.
 *
 * Nothing is returned before `finish()`, so a caller can never act on a call
 * from a response that failed, was cancelled, or ended early.
 */
export class ToolCallCollector {
  private readonly calls: OllamaToolCall[] = [];
  private readonly byIndex = new Map<number, number>();

  add(calls: readonly OllamaToolCall[] | null | undefined): void {
    for (const call of calls ?? []) {
      const index = call.function.index;
      const existing = index === undefined ? undefined : this.byIndex.get(index);
      if (existing !== undefined) {
        this.calls[existing] = call;
      } else {
        if (index !== undefined) this.byIndex.set(index, this.calls.length);
        this.calls.push(call);
      }
    }
  }

  get size(): number {
    return this.calls.length;
  }

  finish(declared: ReadonlySet<string>, newId: () => string): CollectedToolCalls {
    const toolCalls: ToolCall[] = [];
    const invalidToolCalls: InvalidToolCall[] = [];
    const usedIds = new Set<string>();
    for (const call of this.calls) {
      const serverId = call.id?.trim();
      const id = serverId && !usedIds.has(serverId) && serverId.length <= 256 ? serverId : newId();
      usedIds.add(id);
      const name = call.function.name;
      const rawArguments = describeRaw(call.function.arguments);

      if (!declared.has(name)) {
        invalidToolCalls.push({
          id,
          name: truncate(name, 100),
          reason: 'unknown-tool',
          message: `The model called "${truncate(name, 100)}", which is not one of the provided tools.`,
          rawArguments,
        });
        continue;
      }
      const args = parseToolArguments(call.function.arguments);
      if (!args.ok) {
        invalidToolCalls.push({
          id,
          name,
          reason: 'malformed-arguments',
          message: `Invalid arguments for "${name}": ${args.message}`,
          rawArguments,
        });
        continue;
      }
      toolCalls.push({ id, name, arguments: args.value });
    }
    return { toolCalls, invalidToolCalls };
  }
}
