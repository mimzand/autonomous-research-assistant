/*
 * @rka/adk-runtime - the boundary between this app and Google ADK.
 *
 * This entry point never imports ADK itself. Call `loadAdkRuntime()` to
 * sanitise the environment and load the ADK-backed engine.
 */
export {
  ADK_FEATURE_FLAG_PATTERN,
  CLOUD_ENV_VARS,
  FORCED_ENV,
  TELEMETRY_ENV_VARS,
  sanitizeAdkEnvironment,
  type EnvSanitizeReport,
} from './env.js';
export { loadAdkRuntime, type AdkEngine, type AdkRuntime } from './runtime.js';
export type { AdkSelfCheckResult } from './self-check.js';
