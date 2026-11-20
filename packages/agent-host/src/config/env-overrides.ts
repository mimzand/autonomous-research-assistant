import { resolveOllamaBaseUrl } from '@rka/model-provider';
import {
  ENV_OVERRIDE_KEYS,
  EngineChoiceSchema,
  ModelNameSchema,
  SettingsValuesSchema,
  type EnvOverrideKey,
  type SettingsValues,
} from '@rka/shared';

/*
 * Environment overrides for the four user-facing settings in ENV_OVERRIDE_KEYS
 * (Ollama server URL, model, Chat engine, Research engine).
 *
 * Rule: an environment variable is an override only when it is explicitly set
 * to a non-empty, valid value. Absent or empty → no override (the saved value
 * or the default applies). Invalid → no override, plus an actionable error that
 * the Settings page and the log show; nothing silently falls back to a value
 * the user did not choose. The HTTPS policy is checked by the caller, which
 * knows the effective `security.requireHttpsForRemote`.
 */

export const OVERRIDE_ENV_VARS: Readonly<Record<EnvOverrideKey, string>> = {
  'ollama.baseUrl': 'OLLAMA_HOST',
  'model.name': 'OLLAMA_MODEL',
  'engine.chat': 'AGENT_ENGINE',
  'engine.research': 'RESEARCH_ENGINE',
};

export interface EnvOverride<K extends EnvOverrideKey = EnvOverrideKey> {
  readonly key: K;
  readonly envVar: string;
  /** The valid value to apply. */
  readonly value?: SettingsValues[K];
  /** Why the variable was not applied. */
  readonly error?: string;
}

const restartHint = 'Fix or remove the variable and restart the app.';
/** Quoted for messages; user info (`user:password@`) is never echoed into logs or the UI. */
const quote = (raw: string) => {
  const safe = raw.replace(/^([a-z][a-z0-9+.-]*:\/\/)?[^/@\s]*@/i, '$1***@');
  return JSON.stringify(safe.length > 80 ? `${safe.slice(0, 80)}…` : safe);
};

function parse(key: EnvOverrideKey, raw: string): { value: unknown } | { error: string } {
  switch (key) {
    case 'ollama.baseUrl': {
      // resolveOllamaBaseUrl falls back to the local default for unusable input;
      // an explicit override must not, so check the input first.
      const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
      let url: URL;
      try {
        url = new URL(withScheme);
      } catch {
        return { error: 'not a valid server address' };
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:')
        return { error: 'only http:// and https:// are supported' };
      // resolveOllamaBaseUrl would drop these silently; refuse them instead.
      if (url.username || url.password)
        return {
          error:
            'a user name or password in the URL is not allowed (use the access token in Settings)',
        };
      if (url.search || url.hash) return { error: 'a query (?…) or fragment (#…) is not allowed' };
      const value = resolveOllamaBaseUrl(raw);
      const parsed = SettingsValuesSchema.shape['ollama.baseUrl'].safeParse(value);
      return parsed.success
        ? { value: parsed.data }
        : { error: parsed.error.issues[0]?.message ?? 'invalid' };
    }
    case 'model.name': {
      const parsed = ModelNameSchema.safeParse(raw);
      return parsed.success
        ? { value: parsed.data }
        : { error: parsed.error.issues[0]?.message ?? 'invalid' };
    }
    case 'engine.chat':
    case 'engine.research': {
      // Case-insensitive, as before.
      const parsed = EngineChoiceSchema.safeParse(raw.toLowerCase());
      return parsed.success ? { value: parsed.data } : { error: 'use "legacy" or "adk"' };
    }
  }
}

/** Overrides that are explicitly set (valid or not). Absent and empty variables are omitted. */
export function resolveEnvOverrides(env: NodeJS.ProcessEnv): EnvOverride[] {
  const out: EnvOverride[] = [];
  for (const key of ENV_OVERRIDE_KEYS) {
    const envVar = OVERRIDE_ENV_VARS[key];
    const raw = env[envVar]?.trim();
    if (!raw) continue;
    const result = parse(key, raw);
    out.push(
      'value' in result
        ? { key, envVar, value: result.value as never }
        : {
            key,
            envVar,
            error: `${envVar}=${quote(raw)} is not used: ${result.error}. ${restartHint}`,
          },
    );
  }
  return out;
}

/** Message for an override that the HTTPS policy refuses. */
export function httpsPolicyError(envVar: string): string {
  return `${envVar} is not used: it is plain HTTP to another computer, which "Require HTTPS for remote servers" does not allow. ${restartHint}`;
}
