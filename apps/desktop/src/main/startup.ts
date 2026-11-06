import { describeReadiness, type ModelHealth, type ReadinessIssue } from '@rka/shared';

export interface StartupCheckResult {
  readonly ready: boolean;
  readonly issues: readonly ReadinessIssue[];
  readonly summary: string;
}

/**
 * Checks Ollama and the model once at startup (read-only: `/api/version` and
 * `/api/show`). Never pulls a model. Never throws.
 */
export async function checkStartup(
  getHealth: () => Promise<ModelHealth>,
  searchConfigured: boolean,
): Promise<StartupCheckResult> {
  let health: ModelHealth;
  try {
    health = await getHealth();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ready: false, issues: [], summary: `could not check Ollama (${message})` };
  }
  const issues = describeReadiness(health, searchConfigured);
  const ready = !issues.some((i) => i.severity === 'error');
  const summary =
    issues.length === 0
      ? `Ollama ${health.status === 'ready' ? health.serverVersion : ''} ready with ${health.model}`
      : issues.map((i) => i.title).join('; ');
  return { ready, issues, summary };
}
