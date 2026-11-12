import {
  type BaseAgent,
  type BaseSessionService,
  type BaseTool,
  InMemorySessionService,
  isLlmAgent,
  type LlmAgent,
  Runner,
} from './adk.js';
import { isLocalLlm } from './local-llm.js';
import { SqliteSessionService } from './sessions/sqlite-session-service.js';
import { isRegistryTool, type RegistryTool } from './tools/registry-tool.js';

/** An ADK agent or runner configuration this app does not allow. */
export class AdkSecurityError extends Error {
  override readonly name = 'AdkSecurityError';
}

/**
 * Rejects any agent tree that could reach a cloud model, run code, or let the
 * model call tools:
 * - every agent must be an LlmAgent (no workflow/loop/remote/LangGraph agents),
 * - every agent sets its own model, and that model is a LocalLlm instance
 *   (never a model name: names resolve through ADK's registry to Gemini),
 * - no code executor and no planner,
 * - no `outputKey` (ADK would store unvalidated model output in session state),
 * - no tools, except instances the caller lists explicitly:
 *   - `registryTools`: RegistryTool instances (the ToolRegistry bridge), checked
 *     by type and by identity. Production Chat and Research pass none.
 *   - `allowedTools`: test-only tool instances (e.g. an ADK FunctionTool in the
 *     isolated tests). No shipped code passes it (guard test).
 * - the same rules apply to every sub-agent.
 */
export function assertSafeAgent(
  agent: BaseAgent,
  options: AgentGuardOptions = {},
  path: string = agent.name,
): void {
  if (!isLlmAgent(agent)) {
    throw new AdkSecurityError(`Agent "${path}" must be an LlmAgent.`);
  }
  const llm: LlmAgent = agent;
  if (!isLocalLlm(llm.model)) {
    throw new AdkSecurityError(
      `Agent "${path}" must use a local model instance (got ${describeModel(llm.model)}).`,
    );
  }
  if (llm.codeExecutor !== undefined) {
    throw new AdkSecurityError(`Agent "${path}" must not have a code executor.`);
  }
  if (llm.planner !== undefined) {
    throw new AdkSecurityError(`Agent "${path}" must not have a planner.`);
  }
  if (llm.outputKey !== undefined) {
    throw new AdkSecurityError(
      `Agent "${path}" must not use outputKey: validate the final output with structuredOutput() instead.`,
    );
  }
  const allowed = options.allowedTools ?? [];
  const registry = options.registryTools ?? [];
  for (const tool of llm.tools) {
    const permitted =
      allowed.includes(tool as BaseTool) || (isRegistryTool(tool) && registry.includes(tool));
    if (!permitted) {
      throw new AdkSecurityError(
        `Agent "${path}" must not have tools (model-driven tool use is disabled).`,
      );
    }
  }
  for (const sub of llm.subAgents) assertSafeAgent(sub, options, `${path}/${sub.name}`);
}

export interface AgentGuardOptions {
  /**
   * Test-only: the exact tool instances an agent may carry. Used by the
   * isolated ADK tool-calling tests; production code never sets it.
   */
  readonly allowedTools?: readonly BaseTool[];
  /** The RegistryTool instances an agent may carry (explicit allowlist, by identity). */
  readonly registryTools?: readonly RegistryTool[];
}

function describeModel(model: unknown): string {
  if (model === undefined) return 'no model';
  if (typeof model === 'string') return `the model name "${model}"`;
  const name = (model as { constructor?: { name?: string } } | null)?.constructor?.name;
  return name ? `an instance of ${name}` : typeof model;
}

export interface GuardedRunnerOptions {
  readonly appName: string;
  readonly agent: BaseAgent;
  readonly sessionService: BaseSessionService;
  /** Test-only, see AgentGuardOptions. */
  readonly allowedTools?: readonly BaseTool[];
  /** See AgentGuardOptions. */
  readonly registryTools?: readonly RegistryTool[];
}

/**
 * The only way the app creates an ADK Runner. Checks the agent tree, admits
 * only the in-memory or the app's SQLite session service, and never passes plugins or artifact, memory or credential services (which could write
 * files, call cloud services or hold credentials).
 */
export function createGuardedRunner(options: GuardedRunnerOptions): Runner {
  // Only the in-memory service or the app's own SQLite service: never ADK's
  // Database/Vertex AI services (other databases, cloud storage).
  if (
    !(options.sessionService instanceof InMemorySessionService) &&
    !(options.sessionService instanceof SqliteSessionService)
  ) {
    throw new AdkSecurityError(
      'The session service must be InMemorySessionService or SqliteSessionService.',
    );
  }
  assertSafeAgent(options.agent, {
    ...(options.allowedTools && { allowedTools: options.allowedTools }),
    ...(options.registryTools && { registryTools: options.registryTools }),
  });
  return new Runner({
    appName: options.appName,
    agent: options.agent,
    sessionService: options.sessionService,
  });
}
