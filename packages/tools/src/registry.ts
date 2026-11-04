import { err, ok, type Result } from '@rka/shared';
import { z } from 'zod';
import { type ToolDefinition, type ToolSummary } from './tool.js';

const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export type ToolInputError =
  | { readonly kind: 'unknown-tool'; readonly name: string }
  | { readonly kind: 'invalid-input'; readonly name: string; readonly issues: string[] };

export interface ToolRegistry {
  list(): readonly ToolSummary[];
  get(name: string): ToolDefinition | undefined;
  /** Validates raw (model-produced) arguments against the tool's schema. */
  parseInput(name: string, rawInput: unknown): Result<unknown, ToolInputError>;
}

export function createToolRegistry(tools: readonly ToolDefinition[]): ToolRegistry {
  const byName = new Map<string, ToolDefinition>();
  for (const tool of tools) {
    if (!TOOL_NAME_PATTERN.test(tool.name)) {
      throw new Error(`Invalid tool name "${tool.name}" (expected snake_case, max 64 chars).`);
    }
    if (byName.has(tool.name)) {
      throw new Error(`Duplicate tool name "${tool.name}".`);
    }
    byName.set(tool.name, tool);
  }

  const summaries: readonly ToolSummary[] = Object.freeze(
    [...byName.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      requiresApproval: tool.requiresApproval,
      inputJsonSchema: z.toJSONSchema(tool.inputSchema) as Record<string, unknown>,
    })),
  );

  return {
    list: () => summaries,
    get: (name) => byName.get(name),
    parseInput(name, rawInput) {
      const tool = byName.get(name);
      if (!tool) return err({ kind: 'unknown-tool', name });
      const parsed = tool.inputSchema.safeParse(rawInput);
      if (!parsed.success) {
        return err({
          kind: 'invalid-input',
          name,
          issues: parsed.error.issues.map(
            (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
          ),
        });
      }
      return ok(parsed.data);
    },
  };
}
