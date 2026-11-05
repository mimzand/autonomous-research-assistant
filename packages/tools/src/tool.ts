import { type z } from 'zod';

/** What a tool may touch. Shown to the user and enforced by the registry. */
export interface ToolPermissions {
  /**
   * Network access: none, only the user-configured search provider, or public
   * web pages (through the SSRF-safe fetcher).
   */
  readonly network: 'none' | 'search-provider' | 'public-web';
  /**
   * Local files. Tools never take file paths from the model: 'user-selected'
   * means only files the user picked in a native dialog.
   */
  readonly filesystem: 'none' | 'user-selected';
  /** What the tool changes: nothing, the app's own knowledge base, or anything outside the app. */
  readonly effects: 'read-only' | 'knowledge-base' | 'external';
  /** The user must approve each call. Required for external effects. */
  readonly requiresApproval: boolean;
}

/** Context passed to every tool execution. Tools get no access to the registry. */
export interface ToolContext {
  /** Aborted on cancellation or when the tool's timeout expires. */
  readonly signal: AbortSignal;
  /** Task the call belongs to. Required by tools that write to the knowledge base. */
  readonly taskId?: string;
  /** Id of the user's approval. Required for tools with `requiresApproval`. */
  readonly approvalId?: string;
}

/**
 * A tool the agent may call. The schemas are the single source of truth:
 * `inputSchema` validates model-produced arguments (and becomes the JSON
 * schema sent to the model), `outputSchema` validates what the tool returns.
 */
export interface ToolDefinition<
  In extends z.ZodType = z.ZodType,
  Out extends z.ZodType = z.ZodType,
> {
  /** snake_case, max 64 chars. */
  readonly name: string;
  readonly description: string;
  readonly inputSchema: In;
  readonly outputSchema: Out;
  /** Hard deadline for one call, in ms (1 ms - 10 min). */
  readonly timeoutMs: number;
  readonly permissions: ToolPermissions;
  execute(input: z.output<In>, context: ToolContext): Promise<z.input<Out>>;
}

/** Identity helper that preserves the schema types for `execute`. */
export function defineTool<In extends z.ZodType, Out extends z.ZodType>(
  tool: ToolDefinition<In, Out>,
): ToolDefinition<In, Out> {
  return tool;
}

/** Tool metadata safe to show in the UI or send to the model. */
export interface ToolSummary {
  readonly name: string;
  readonly description: string;
  readonly timeoutMs: number;
  readonly permissions: ToolPermissions;
  /** Kept for existing callers; same as permissions.requiresApproval. */
  readonly requiresApproval: boolean;
  readonly inputJsonSchema: Record<string, unknown>;
  readonly outputJsonSchema: Record<string, unknown>;
}
