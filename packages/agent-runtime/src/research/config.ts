import { ResearchLimitsSchema, type ResearchLimits } from './schemas.js';

/** Environment variables for research defaults (all optional). */
export interface ResearchEnv {
  readonly RESEARCH_MODEL_RETRIES?: string | undefined;
  readonly RESEARCH_TOOL_RETRIES?: string | undefined;
  readonly RESEARCH_RETRY_BACKOFF_MS?: string | undefined;
  readonly RESEARCH_MODEL_TIMEOUT_MS?: string | undefined;
  readonly RESEARCH_MAX_QUESTIONS?: string | undefined;
  readonly RESEARCH_MAX_SOURCES?: string | undefined;
}

const KEYS: Record<keyof ResearchEnv, keyof ResearchLimits> = {
  RESEARCH_MODEL_RETRIES: 'modelRetries',
  RESEARCH_TOOL_RETRIES: 'toolRetries',
  RESEARCH_RETRY_BACKOFF_MS: 'retryBackoffMs',
  RESEARCH_MODEL_TIMEOUT_MS: 'modelTimeoutMs',
  RESEARCH_MAX_QUESTIONS: 'maxQuestions',
  RESEARCH_MAX_SOURCES: 'maxSources',
};

/**
 * Reads research defaults from the environment. Values are validated with
 * the same bounds as per-task limits; an invalid value throws (at startup)
 * rather than being ignored. Each task stores its own limits, so changing
 * these only affects new tasks.
 */
export function loadResearchConfig(env: ResearchEnv): Partial<ResearchLimits> {
  const raw: Record<string, number> = {};
  for (const [name, key] of Object.entries(KEYS) as [keyof ResearchEnv, keyof ResearchLimits][]) {
    const value = env[name]?.trim();
    if (value) raw[key] = Number(value);
  }
  const parsed = ResearchLimitsSchema.partial().safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path[0];
    const variable = Object.entries(KEYS).find(([, k]) => k === field)?.[0] ?? String(field);
    throw new Error(`Invalid ${variable}: ${issue?.message ?? 'invalid value'}`);
  }
  return Object.fromEntries(
    Object.entries(parsed.data).filter(([key]) => key in raw),
  ) as Partial<ResearchLimits>;
}
