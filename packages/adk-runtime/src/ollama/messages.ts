import {
  type ChatMessage,
  type GenerateResult,
  type ToolCall,
  ToolNameSchema,
} from '@rka/model-provider';
import { type Content, type GenerateContentConfig, type Part } from '../adk.js';
import { ADAPTER_ERROR_CODES, AdkConversionError } from './errors.js';

/*
 * Message conversion between ADK (Google GenAI `Content`/`Part`) and the
 * provider's chat messages (which the provider sends to Ollama).
 *
 * ADK → provider:
 * - `config.systemInstruction` → one leading system message (text only).
 * - user content: text parts → a user message (parts joined by a blank line);
 *   each `functionResponse` → a tool message (id, name, JSON result), in order.
 * - model content: text parts → assistant text (joined as-is, since a model
 *   turn is one continuous text); `functionCall` parts → the turn's tool calls.
 * - `thought` parts (the model's own reasoning) are deliberately not sent back.
 * - Anything else (images, files, audio, executable code, code results, …) is
 *   rejected with OLLAMA_UNSUPPORTED_CONTENT. Nothing is dropped silently.
 *
 * Provider → ADK: thinking (when requested) → a `thought` part; text → a text
 * part; each tool call → a `functionCall` part with its id, name and args.
 */

function unsupported(message: string): never {
  throw new AdkConversionError(ADAPTER_ERROR_CODES.unsupportedContent, message);
}

/** The only Part fields the adapter understands. Others make a part unsupported. */
const KNOWN_PART_KEYS = new Set([
  'text',
  'thought',
  'thoughtSignature',
  'functionCall',
  'functionResponse',
]);

function partKind(part: Part, where: string): 'text' | 'thought' | 'call' | 'response' | 'empty' {
  const keys = Object.entries(part)
    .filter(([, v]) => v !== undefined)
    .map(([k]) => k);
  const unknown = keys.filter((k) => !KNOWN_PART_KEYS.has(k));
  if (unknown.length > 0)
    unsupported(
      `${where}: unsupported content (${unknown.join(', ')}). Only text and function calls/responses are supported.`,
    );
  if (part.functionCall) return 'call';
  if (part.functionResponse) return 'response';
  if (typeof part.text === 'string') return part.thought ? 'thought' : 'text';
  return 'empty';
}

function systemText(instruction: GenerateContentConfig['systemInstruction']): string | undefined {
  if (instruction === undefined || instruction === null) return undefined;
  if (typeof instruction === 'string') return instruction;
  const parts: unknown[] = Array.isArray(instruction)
    ? instruction
    : 'parts' in (instruction as object)
      ? ((instruction as Content).parts ?? [])
      : [instruction];
  return parts
    .map((part, i) => {
      if (typeof part === 'string') return part;
      const kind = partKind(part as Part, `system instruction part ${i}`);
      if (kind !== 'text') unsupported(`system instruction part ${i}: only text is supported.`);
      return (part as Part).text ?? '';
    })
    .join('\n\n');
}

function toolName(name: string | undefined, where: string): string {
  if (!name || !ToolNameSchema.safeParse(name).success) {
    unsupported(`${where}: invalid function name ${JSON.stringify(name)}.`);
  }
  return name;
}

function stringifyResponse(response: unknown): string {
  try {
    return JSON.stringify(response ?? {});
  } catch {
    return unsupported('function response is not JSON-serialisable.');
  }
}

/** Converts ADK's request contents (and system instruction) to provider chat messages. */
export function toChatMessages(
  contents: readonly Content[],
  instruction?: GenerateContentConfig['systemInstruction'],
): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const system = systemText(instruction);
  if (system?.trim()) messages.push({ role: 'system', content: system });

  contents.forEach((content, c) => {
    const role = content.role ?? 'user';
    const parts = content.parts ?? [];
    if (role === 'user') {
      let text: string[] = [];
      const flush = () => {
        if (text.length > 0) messages.push({ role: 'user', content: text.join('\n\n') });
        text = [];
      };
      parts.forEach((part, p) => {
        const where = `content ${c} part ${p}`;
        const kind = partKind(part, where);
        if (kind === 'text') text.push(part.text ?? '');
        else if (kind === 'response') {
          flush();
          const response = part.functionResponse;
          if (!response?.id) unsupported(`${where}: function response without an id.`);
          messages.push({
            role: 'tool',
            toolCallId: response.id,
            name: toolName(response.name, where),
            content: stringifyResponse(response.response),
          });
        } else if (kind === 'call')
          unsupported(`${where}: a user turn cannot contain a function call.`);
      });
      flush();
    } else if (role === 'model') {
      let text = '';
      const toolCalls: ToolCall[] = [];
      parts.forEach((part, p) => {
        const where = `content ${c} part ${p}`;
        const kind = partKind(part, where);
        if (kind === 'text') text += part.text ?? '';
        else if (kind === 'call') {
          const call = part.functionCall;
          if (!call?.id) unsupported(`${where}: function call without an id.`);
          toolCalls.push({
            id: call.id,
            name: toolName(call.name, where),
            arguments: { ...(call.args ?? {}) },
          });
        } else if (kind === 'response')
          unsupported(`${where}: a model turn cannot contain a function response.`);
      });
      if (text || toolCalls.length > 0) {
        messages.push(
          toolCalls.length > 0
            ? { role: 'assistant', content: text, toolCalls }
            : { role: 'assistant', content: text },
        );
      }
    } else {
      unsupported(`content ${c}: unsupported role ${JSON.stringify(role)}.`);
    }
  });
  return messages;
}

/** The model's turn as ADK parts. */
export function toModelParts(
  result: Pick<GenerateResult, 'content' | 'thinking' | 'toolCalls'>,
  contentOverride?: string,
): Part[] {
  const parts: Part[] = [];
  if (result.thinking) parts.push({ text: result.thinking, thought: true });
  const content = contentOverride ?? result.content;
  if (content) parts.push({ text: content });
  for (const call of result.toolCalls ?? []) {
    parts.push({ functionCall: { id: call.id, name: call.name, args: { ...call.arguments } } });
  }
  return parts;
}
