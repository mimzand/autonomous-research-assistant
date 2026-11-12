import {
  type BaseAgent,
  type BaseSessionService,
  isLlmAgent,
  type LlmAgent,
  Runner,
} from './adk.js';
import { isLocalLlm } from './local-llm.js';

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
 * - no tools (model-driven tool use is not part of this app),
 * - the same rules apply to every sub-agent.
 */
export function assertSafeAgent(agent: BaseAgent, path: string = agent.name): void {
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
  if (llm.tools.length > 0) {
    throw new AdkSecurityError(
      `Agent "${path}" must not have tools (model-driven tool use is disabled).`,
    );
  }
  for (const sub of llm.subAgents) assertSafeAgent(sub, `${path}/${sub.name}`);
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
}

/**
 * The only way the app creates an ADK Runner. Checks the agent tree and never
 * passes plugins or artifact, memory or credential services (which could write
 * files, call cloud services or hold credentials).
 */
export function createGuardedRunner(options: GuardedRunnerOptions): Runner {
  assertSafeAgent(options.agent);
  return new Runner({
    appName: options.appName,
    agent: options.agent,
    sessionService: options.sessionService,
  });
}
