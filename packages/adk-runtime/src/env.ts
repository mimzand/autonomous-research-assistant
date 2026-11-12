/*
 * Environment sanitisation for Google ADK.
 *
 * The variable names below are the ones the installed @google/adk@2.4.0 (and
 * the Google libraries it pulls in) actually read - found by inspecting its
 * dist/esm sources, not its documentation. Only these names are touched; every
 * other variable is left alone.
 *
 * - Telemetry: ADK builds OTLP exporters when an OTEL_EXPORTER_OTLP_* endpoint
 *   is set, and records prompts/responses in spans unless
 *   ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS is "false".
 * - Cloud models and auth: Gemini / Vertex AI / Agent Engine read these keys,
 *   project ids and credential paths. This app never uses Google models, so
 *   they are removed from this process before ADK is loaded.
 * - ADK feature flags (ADK_ENABLE_* / ADK_DISABLE_*) switch experimental code
 *   paths on and off. They are removed so ADK behaves the same on every machine.
 */

/** Removed: would enable OTLP export of traces, metrics or logs. */
export const TELEMETRY_ENV_VARS = [
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
  'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
  'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
] as const;

/** Removed: Gemini / Vertex AI / Google Cloud authentication and routing. */
export const CLOUD_ENV_VARS = [
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_GENAI_API_KEY',
  'GOOGLE_GENAI_USE_VERTEXAI',
  'GOOGLE_GENAI_USE_ENTERPRISE',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_LOCATION',
  'GOOGLE_CLOUD_AGENT_ENGINE_ID',
  'GOOGLE_APPLICATION_CREDENTIALS',
] as const;

/** Removed: ADK feature toggles (e.g. ADK_ENABLE_PROGRESSIVE_SSE_STREAMING). */
export const ADK_FEATURE_FLAG_PATTERN = /^ADK_(ENABLE|DISABLE)_[A-Z0-9_]+$/;

/** Always set, overriding any inherited value. */
export const FORCED_ENV = Object.freeze({
  /** Standard OpenTelemetry switch: SDK components that read the environment stay no-ops. */
  OTEL_SDK_DISABLED: 'true',
  /** ADK: never copy prompts or model responses into tracing spans. */
  ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS: 'false',
});

export interface EnvSanitizeReport {
  /** Names of the variables that were removed (never their values). */
  readonly removed: readonly string[];
  /** Names of the variables that were set to a fixed value. */
  readonly forced: readonly string[];
}

/**
 * Removes the telemetry, Google Cloud and ADK feature-flag variables listed
 * above from `env` and pins the forced values. Idempotent. Must run before
 * ADK is loaded or used.
 */
export function sanitizeAdkEnvironment(env: NodeJS.ProcessEnv): EnvSanitizeReport {
  const removed: string[] = [];
  const remove = (name: string) => {
    if (Object.hasOwn(env, name)) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- names come from the fixed lists above
      delete env[name];
      removed.push(name);
    }
  };

  for (const name of TELEMETRY_ENV_VARS) remove(name);
  for (const name of CLOUD_ENV_VARS) remove(name);
  for (const name of Object.keys(env)) {
    if (ADK_FEATURE_FLAG_PATTERN.test(name)) remove(name);
  }

  const forced: string[] = [];
  for (const [name, value] of Object.entries(FORCED_ENV)) {
    env[name] = value;
    forced.push(name);
  }
  return { removed, forced };
}
