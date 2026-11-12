import { loadAdkRuntime, type AdkRuntime } from '@rka/adk-runtime';

/**
 * Migration phase 1: loads Google ADK in the main process and runs its
 * offline self-check (an in-memory agent turn with a stand-in model - no
 * Ollama call, no network). No chat or research code uses ADK yet; this only
 * proves the runtime works inside Electron. Never throws: a failure is
 * reported in the summary and the app keeps working without ADK.
 */
export async function probeAdkRuntime(
  load: () => Promise<AdkRuntime> = loadAdkRuntime,
): Promise<{ ok: boolean; summary: string }> {
  try {
    const runtime = await load();
    const check = await runtime.engine.runAdkSelfCheck();
    const removed = runtime.environment.removed;
    const env = removed.length
      ? `removed ${removed.length} environment variable(s): ${removed.join(', ')}`
      : 'no telemetry or Google Cloud variables were set';
    return check.ok
      ? {
          ok: true,
          summary: `@google/adk ${runtime.version} loaded, self-check passed in ${check.durationMs} ms; ${env}.`,
        }
      : {
          ok: false,
          summary: `@google/adk ${runtime.version} loaded, but the self-check failed: ${check.error ?? 'unknown error'}.`,
        };
  } catch (error) {
    return {
      ok: false,
      summary: `@google/adk could not be loaded: ${error instanceof Error ? error.message : String(error)}.`,
    };
  }
}
