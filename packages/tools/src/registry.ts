import { err, ok, type Result } from '@rka/shared';
import { z } from 'zod';
import { type ToolContext, type ToolDefinition, type ToolSummary } from './tool.js';

const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_TIMEOUT_MS = 10 * 60_000;

export type ToolInputError =
  | { readonly kind: 'unknown-tool'; readonly name: string }
  | { readonly kind: 'invalid-input'; readonly name: string; readonly issues: string[] };

export type ToolExecutionError =
  | ToolInputError
  | { readonly kind: 'approval-required'; readonly name: string; readonly message: string }
  | { readonly kind: 'timeout'; readonly name: string; readonly message: string }
  | { readonly kind: 'cancelled'; readonly name: string; readonly message: string }
  | {
      readonly kind: 'failed';
      readonly name: string;
      readonly message: string;
      /** Machine-readable error code from the tool, when it has one. */
      readonly code?: string;
    }
  | { readonly kind: 'invalid-output'; readonly name: string; readonly issues: string[] };

export interface ToolRegistry {
  list(): readonly ToolSummary[];
  get(name: string): ToolDefinition | undefined;
  /** Validates raw (model-produced) arguments against the tool's schema. */
  parseInput(name: string, rawInput: unknown): Result<unknown, ToolInputError>;
  /**
   * Validates the input, checks approval, runs the tool with its timeout and
   * validates the output. Never throws.
   */
  execute(
    name: string,
    rawInput: unknown,
    context: ToolContext,
  ): Promise<Result<unknown, ToolExecutionError>>;
}

const issueList = (error: z.ZodError) =>
  error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);

function validateDefinition(tool: ToolDefinition): void {
  if (!TOOL_NAME_PATTERN.test(tool.name)) {
    throw new Error(`Invalid tool name "${tool.name}" (expected snake_case, max 64 chars).`);
  }
  if (!tool.description.trim()) throw new Error(`Tool "${tool.name}" needs a description.`);
  if (!Number.isInteger(tool.timeoutMs) || tool.timeoutMs < 1 || tool.timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`Tool "${tool.name}" has an invalid timeout (1 ms - 10 min).`);
  }
  const p = tool.permissions;
  if (p.effects === 'external' && !p.requiresApproval) {
    throw new Error(`Tool "${tool.name}" has external effects and must require approval.`);
  }
}

export function createToolRegistry(tools: readonly ToolDefinition[]): ToolRegistry {
  const byName = new Map<string, ToolDefinition>();
  for (const tool of tools) {
    validateDefinition(tool);
    if (byName.has(tool.name)) {
      throw new Error(`Duplicate tool name "${tool.name}".`);
    }
    byName.set(tool.name, tool);
  }

  const summaries: readonly ToolSummary[] = Object.freeze(
    [...byName.values()].map((tool) =>
      Object.freeze({
        name: tool.name,
        description: tool.description,
        timeoutMs: tool.timeoutMs,
        permissions: Object.freeze({ ...tool.permissions }),
        requiresApproval: tool.permissions.requiresApproval,
        inputJsonSchema: z.toJSONSchema(tool.inputSchema, { io: 'input' }) as Record<
          string,
          unknown
        >,
        outputJsonSchema: z.toJSONSchema(tool.outputSchema, { io: 'output' }) as Record<
          string,
          unknown
        >,
      }),
    ),
  );

  function parseInput(name: string, rawInput: unknown): Result<unknown, ToolInputError> {
    const tool = byName.get(name);
    if (!tool) return err({ kind: 'unknown-tool', name });
    const parsed = tool.inputSchema.safeParse(rawInput);
    if (!parsed.success) {
      return err({ kind: 'invalid-input', name, issues: issueList(parsed.error) });
    }
    return ok(parsed.data);
  }

  return {
    list: () => summaries,
    get: (name) => byName.get(name),
    parseInput,

    async execute(name, rawInput, context) {
      const input = parseInput(name, rawInput);
      if (!input.ok) return input;
      const tool = byName.get(name);
      if (!tool) return err({ kind: 'unknown-tool', name });
      if (tool.permissions.requiresApproval && !context.approvalId) {
        return err({
          kind: 'approval-required',
          name,
          message: `"${name}" needs the user's approval before it can run.`,
        });
      }
      if (context.signal.aborted) {
        return err({ kind: 'cancelled', name, message: 'Cancelled before the tool started.' });
      }

      const deadline = AbortSignal.timeout(tool.timeoutMs);
      const signal = AbortSignal.any([context.signal, deadline]);
      // Resolves when the call is aborted, even if the tool ignores its signal.
      let onAbort: (() => void) | undefined;
      const aborted = new Promise<'aborted'>((resolve) => {
        onAbort = () => resolve('aborted');
        signal.addEventListener('abort', onAbort, { once: true });
      });

      let output: unknown;
      try {
        const result = await Promise.race([
          tool.execute(input.value, { ...context, signal }),
          aborted,
        ]);
        if (result === 'aborted' || signal.aborted) throw signal.reason;
        output = result;
      } catch (error) {
        if (context.signal.aborted) {
          return err({ kind: 'cancelled', name, message: 'The tool call was cancelled.' });
        }
        if (deadline.aborted) {
          return err({
            kind: 'timeout',
            name,
            message: `"${name}" did not finish within ${tool.timeoutMs} ms.`,
          });
        }
        const code = (error as { code?: unknown } | null)?.code;
        return err({
          kind: 'failed',
          name,
          message: error instanceof Error ? error.message : String(error),
          ...(typeof code === 'string' && { code }),
        });
      } finally {
        if (onAbort) signal.removeEventListener('abort', onAbort);
      }

      const parsed = tool.outputSchema.safeParse(output);
      if (!parsed.success) {
        return err({ kind: 'invalid-output', name, issues: issueList(parsed.error) });
      }
      return ok(parsed.data);
    },
  };
}
