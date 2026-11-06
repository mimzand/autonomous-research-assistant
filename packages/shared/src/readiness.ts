import { type ModelHealth } from './model.js';

/** One thing the user must fix before research can run. */
export interface ReadinessIssue {
  readonly id: 'ollama-unreachable' | 'model-missing' | 'search-not-configured';
  readonly severity: 'error' | 'warn';
  readonly title: string;
  readonly detail: string;
  /** A command the user can run themselves. The app never runs it. */
  readonly command: string | null;
}

/**
 * What blocks the app at startup: Ollama not reachable, the configured model
 * not installed, or web search not configured. The app never downloads a
 * model itself; it only shows the `ollama pull` command to run.
 */
export function describeReadiness(
  health: ModelHealth,
  searchConfigured: boolean,
): ReadinessIssue[] {
  const issues: ReadinessIssue[] = [];
  if (health.status === 'unreachable') {
    issues.push({
      id: 'ollama-unreachable',
      severity: 'error',
      title: `Ollama is not reachable at ${health.baseUrl}`,
      detail:
        'Install Ollama from ollama.com and start it (it runs in the system tray), or set OLLAMA_HOST if it runs on another port.',
      command: null,
    });
  } else if (health.status === 'model-missing') {
    issues.push({
      id: 'model-missing',
      severity: 'error',
      title: `The model ${health.model} is not installed`,
      detail: `Run this command in a terminal, then click "Check again". It downloads several GB. Installed models: ${
        health.installedModels.join(', ') || 'none'
      }.`,
      command: `ollama pull ${health.model}`,
    });
  }
  if (!searchConfigured) {
    issues.push({
      id: 'search-not-configured',
      severity: 'warn',
      title: 'Web search is not configured',
      detail:
        'Research needs a SearXNG instance. Set SEARXNG_URL in settings.env in the app data folder and restart the app.',
      command: null,
    });
  }
  return issues;
}
