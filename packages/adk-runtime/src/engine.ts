/**
 * The ADK-backed part of this package. Loaded only through `loadAdkRuntime()`,
 * after the environment has been sanitised, so ADK never initialises with
 * telemetry or Google Cloud variables present.
 */
export { ADK_VERSION } from './adk.js';
export { AdkSecurityError, assertSafeAgent, createGuardedRunner } from './guards.js';
export { LocalLlm, isLocalLlm } from './local-llm.js';
export { runAdkSelfCheck, type AdkSelfCheckResult } from './self-check.js';
