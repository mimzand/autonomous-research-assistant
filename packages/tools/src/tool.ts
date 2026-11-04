import { type z } from 'zod';

/** Context passed to every tool execution. */
export interface ToolContext {
  readonly signal: AbortSignal;
}

/**
 * A tool the agent may call. `inputSchema` is the single source of truth:
 * it validates model-produced arguments and generates the JSON schema sent
 * to the model. Tools that write or change anything must set
 * `requiresApproval: true`.
 */
export interface ToolDefinition<Schema extends z.ZodType = z.ZodType, Output = unknown> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Schema;
  readonly requiresApproval: boolean;
  execute(input: z.output<Schema>, context: ToolContext): Promise<Output>;
}

/** Identity helper that preserves the input type for `execute`. */
export function defineTool<Schema extends z.ZodType, Output>(
  tool: ToolDefinition<Schema, Output>,
): ToolDefinition<Schema, Output> {
  return tool;
}

/** Tool metadata safe to show in the UI or send to the model. */
export interface ToolSummary {
  readonly name: string;
  readonly description: string;
  readonly requiresApproval: boolean;
  readonly inputJsonSchema: Record<string, unknown>;
}
