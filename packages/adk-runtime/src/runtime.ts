import type * as Engine from './engine.js';
import { sanitizeAdkEnvironment, type EnvSanitizeReport } from './env.js';

/** Type-only: the engine module is loaded dynamically by `loadAdkRuntime()`. */
export type AdkEngine = typeof Engine;

export interface AdkRuntime {
  readonly version: string;
  readonly environment: EnvSanitizeReport;
  readonly engine: AdkEngine;
}

let loading: Promise<AdkRuntime> | undefined;

/**
 * Sanitises the environment, then loads ADK. ADK is imported dynamically so
 * that no ADK module is evaluated before the sanitisation (and so it stays off
 * the app's startup path). Subsequent calls return the same runtime.
 */
export function loadAdkRuntime(env: NodeJS.ProcessEnv = process.env): Promise<AdkRuntime> {
  loading ??= (async () => {
    const environment = sanitizeAdkEnvironment(env);
    const engine = await import('./engine.js');
    return { version: engine.ADK_VERSION, environment, engine };
  })();
  return loading;
}
