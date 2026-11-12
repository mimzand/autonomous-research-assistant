/*
 * Test-only tool-calling harness. Not exported from the package entry point
 * and not used by the app: Chat and Research never let the model call tools.
 *
 * It runs the full loop against a ModelProvider: send the request with tool
 * definitions, receive tool calls, validate their arguments with Zod, execute
 * the (test) tool, send the results back, and repeat until the model answers.
 */
import { z } from 'zod';
import { type ModelProvider } from '../provider.js';
import {
  type CallOptions,
  type ChatMessage,
  type GenerateRequest,
  type GenerateResult,
} from '../schemas.js';
import {
  assistantToolCallMessage,
  defineTool,
  toolErrorMessage,
  toolResultMessage,
  validateToolArguments,
  type TypedTool,
} from '../tools.js';

export interface HarnessTool<Input extends z.ZodObject = z.ZodObject> {
  readonly tool: TypedTool<Input>;
  readonly run: (args: z.output<Input>) => unknown;
}

export interface ToolLoopEvent {
  readonly round: number;
  readonly kind: 'executed' | 'rejected';
  readonly name: string;
  readonly callId: string;
  readonly detail: unknown;
}

export interface ToolLoopResult {
  readonly final: GenerateResult;
  readonly messages: ChatMessage[];
  readonly events: ToolLoopEvent[];
  readonly rounds: number;
}

/** Runs the tool loop. Throws if the model is still calling tools after `maxRounds`. */
export async function runToolLoop(params: {
  provider: ModelProvider;
  messages: ChatMessage[];
  tools: readonly HarnessTool[];
  request?: Omit<GenerateRequest, 'messages' | 'tools'>;
  stream?: boolean;
  maxRounds?: number;
  callOptions?: CallOptions;
}): Promise<ToolLoopResult> {
  const { provider, tools, stream = false, maxRounds = 4 } = params;
  const byName = new Map(tools.map((t) => [t.tool.definition.name, t]));
  const messages = [...params.messages];
  const events: ToolLoopEvent[] = [];

  for (let round = 1; round <= maxRounds; round++) {
    const request: GenerateRequest = {
      ...params.request,
      messages,
      tools: tools.map((t) => t.tool.definition),
    };
    const result = stream
      ? await finalOf(provider.generateStream(request, params.callOptions))
      : await provider.generate(request, params.callOptions);

    const calls = result.toolCalls ?? [];
    const invalid = result.invalidToolCalls ?? [];
    if (calls.length === 0 && invalid.length === 0) {
      return {
        final: result,
        messages: [...messages, assistantToolCallMessage(result)],
        events,
        rounds: round,
      };
    }

    messages.push(assistantToolCallMessage(result));
    for (const call of calls) {
      const entry = byName.get(call.name);
      const args = entry ? validateToolArguments(entry.tool, call) : undefined;
      if (!entry || !args?.ok) {
        const message = args && !args.ok ? args.message : `Unknown tool "${call.name}".`;
        events.push({ round, kind: 'rejected', name: call.name, callId: call.id, detail: message });
        messages.push(toolErrorMessage(call, message));
        continue;
      }
      const output = await entry.run(args.value);
      events.push({
        round,
        kind: 'executed',
        name: call.name,
        callId: call.id,
        detail: { args: args.value, output },
      });
      messages.push(toolResultMessage(call, output));
    }
    for (const call of invalid) {
      events.push({
        round,
        kind: 'rejected',
        name: call.name,
        callId: call.id,
        detail: call.message,
      });
      messages.push(toolErrorMessage(call, call.message));
    }
  }
  throw new Error(`The model was still calling tools after ${maxRounds} rounds.`);
}

async function finalOf(stream: AsyncIterable<{ type: string; result?: GenerateResult }>) {
  for await (const chunk of stream) {
    if (chunk.type === 'done' && chunk.result) return chunk.result;
  }
  throw new Error('Stream ended without a result.');
}

/** The calculator used by the harness tests. Plain arithmetic, no expression evaluation. */
export const calculator: HarnessTool = (() => {
  const tool = defineTool({
    name: 'calculator',
    description:
      'Performs one arithmetic operation on two numbers and returns the exact result. Use it for any calculation.',
    input: z.strictObject({
      operation: z.enum(['add', 'subtract', 'multiply', 'divide']),
      a: z.number().describe('First operand'),
      b: z.number().describe('Second operand'),
    }),
  });
  return {
    tool,
    run: (args) => {
      const { operation, a, b } = args as { operation: string; a: number; b: number };
      switch (operation) {
        case 'add':
          return { result: a + b };
        case 'subtract':
          return { result: a - b };
        case 'multiply':
          return { result: a * b };
        default:
          return b === 0 ? { error: 'Division by zero.' } : { result: a / b };
      }
    },
  };
})();
