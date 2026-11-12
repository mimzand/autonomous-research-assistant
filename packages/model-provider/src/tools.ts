import { type z } from 'zod';
import {
  ToolDefinitionSchema,
  ToolNameSchema,
  type ChatMessage,
  type GenerateResult,
  type InvalidToolCall,
  type ToolCall,
  type ToolDefinition,
  type ToolResultMessage,
} from './schemas.js';
import { toModelJsonSchema } from './structured.js';

/*
 * Helpers for building tool-calling conversations. They describe tools,
 * validate model-produced arguments and format results. None of them executes
 * a tool: running a tool is always the caller's explicit decision.
 */

/** A tool definition plus the Zod schema its arguments are validated with. */
export interface TypedTool<Input extends z.ZodObject = z.ZodObject> {
  readonly definition: ToolDefinition;
  readonly input: Input;
}

/** Describes a tool for the model; the JSON Schema is derived from `input`. */
export function defineTool<Input extends z.ZodObject>(spec: {
  name: string;
  description: string;
  input: Input;
}): TypedTool<Input> {
  const definition = ToolDefinitionSchema.parse({
    name: spec.name,
    description: spec.description,
    parameters: toModelJsonSchema(spec.input),
  });
  return { definition, input: spec.input };
}

export type ToolArgumentsResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

/**
 * Validates a call's arguments with the tool's Zod schema. Model output is
 * untrusted: never run a tool with arguments that did not pass this check.
 */
export function validateToolArguments<Input extends z.ZodObject>(
  tool: TypedTool<Input>,
  call: ToolCall,
): ToolArgumentsResult<z.output<Input>> {
  if (call.name !== tool.definition.name) {
    return { ok: false, message: `Call is for "${call.name}", not "${tool.definition.name}".` };
  }
  const parsed = tool.input.safeParse(call.arguments);
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    message: `Invalid arguments for "${call.name}": ${parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ')}`,
  };
}

const safeName = (name: string) => (ToolNameSchema.safeParse(name).success ? name : 'invalid_tool');

/**
 * The assistant turn to put back into the conversation before the tool
 * results: its text plus every tool call (rejected calls included, with empty
 * arguments, so that each can be answered by id).
 */
export function assistantToolCallMessage(result: GenerateResult): ChatMessage {
  const calls: ToolCall[] = [
    ...(result.toolCalls ?? []),
    ...(result.invalidToolCalls ?? []).map((c) => ({
      id: c.id,
      name: safeName(c.name),
      arguments: {},
    })),
  ];
  return calls.length > 0
    ? { role: 'assistant', content: result.content, toolCalls: calls }
    : { role: 'assistant', content: result.content };
}

/** A tool result for the model. Objects are sent as JSON. */
export function toolResultMessage(
  call: Pick<ToolCall, 'id' | 'name'>,
  output: unknown,
): ToolResultMessage {
  return {
    role: 'tool',
    toolCallId: call.id,
    name: safeName(call.name),
    content: typeof output === 'string' ? output : JSON.stringify(output),
  };
}

/** An error result for the model, so it can correct the call. */
export function toolErrorMessage(
  call: Pick<ToolCall | InvalidToolCall, 'id' | 'name'>,
  message: string,
): ToolResultMessage {
  return toolResultMessage({ id: call.id, name: call.name }, { error: message });
}
