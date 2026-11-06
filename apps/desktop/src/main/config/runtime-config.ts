import { loadResearchConfig } from '@rka/agent-runtime';
import { loadOllamaConfig } from '@rka/model-provider';
import {
  connectionAdvice,
  normalizeServerUrl,
  RESTART_REQUIRED_KEYS,
  SECRET_SETTING_KEYS,
  SETTING_DEFINITION_BY_KEY,
  SETTING_DEFINITIONS,
  SETTING_KEYS,
  SettingsValuesSchema,
  violatesHttpsPolicy,
  type SecretSettingKey,
  type SettingErrors,
  type SettingKey,
  type SettingSource,
  type SettingsUpdateResult,
  type SettingsValidateResult,
  type SettingsValues,
  type SettingsView,
} from '@rka/shared';
import { type Storage } from '@rka/storage';
import { loadWebConfig } from '@rka/tools';

/*
 * Runtime Configuration Manager: the single owner of the app's settings.
 *
 * Layers (lowest → highest):
 *   1. built-in defaults (SETTING_DEFINITIONS)
 *   2. environment: .env / settings.env / process environment, read once at
 *      startup with the existing loaders (they also validate)
 *   3. values saved from the Settings page, in the SQLite `settings` table
 *
 * Changes are validated (Zod + cross-field rules), applied to the running
 * services, then persisted; if applying or persisting fails, everything is
 * rolled back, so the database and the running app never disagree.
 * `.env` files are never written.
 */

/** Saved values live under this prefix in the `settings` table. */
export const SAVED_PREFIX = 'settings.';
/** Secrets live under this prefix, encrypted with the OS key store (safeStorage). */
export const SECRET_PREFIX = 'secret.';

/** A running service that depends on some settings. */
export interface ConfigApplier {
  readonly name: string;
  readonly keys: readonly SettingKey[];
  /** Applies `next`. Must throw (and change nothing) when it cannot. */
  apply(next: SettingsValues, previous: SettingsValues): void;
}

export interface ConfigChange {
  readonly changed: readonly string[];
  readonly values: SettingsValues;
}

export interface RuntimeConfigDeps {
  readonly storage: Pick<Storage, 'settings' | 'transaction'>;
  readonly env: NodeJS.ProcessEnv;
  /** Whether OS encryption (Electron safeStorage) is available. */
  readonly encryptionAvailable: () => boolean;
  /** Startup warnings (e.g. a saved value no longer valid) go here. */
  readonly warn?: (message: string) => void;
}

export interface UpdateOptions {
  /** Allows settings that the renderer may not set directly (e.g. the backup folder from the folder picker). */
  readonly internal?: boolean;
}

const defsByKey = SETTING_DEFINITION_BY_KEY;
const isKey = (key: string): key is SettingKey => defsByKey.has(key as SettingKey);

/**
 * Environment layer: values come from the existing loaders, so the same
 * parsing and validation as before applies (an invalid value stops startup).
 * Only keys whose environment variable is set count as "environment".
 */
export function environmentDefaults(env: NodeJS.ProcessEnv): {
  values: Partial<SettingsValues>;
  vars: Partial<Record<SettingKey, string>>;
} {
  const ollama = loadOllamaConfig(env);
  const web = loadWebConfig(env);
  const research = loadResearchConfig(env);
  const all: Partial<SettingsValues> = {
    'model.name': ollama.model,
    'model.numCtx': ollama.numCtx,
    'model.generateTimeoutMs': ollama.generateTimeoutMs,
    'ollama.baseUrl': ollama.baseUrl,
    'ollama.requestTimeoutMs': ollama.requestTimeoutMs,
    'ollama.streamIdleTimeoutMs': ollama.streamIdleTimeoutMs,
    'searxng.url': web.searxngUrl,
    'searxng.safeSearch': web.safeSearch,
    'web.searchTimeoutMs': web.searchTimeoutMs,
    'web.fetchTimeoutMs': web.fetchTimeoutMs,
    'web.maxDownloadBytes': web.maxDownloadBytes,
    ...(research.maxQuestions !== undefined && { 'research.maxQuestions': research.maxQuestions }),
    ...(research.maxSources !== undefined && { 'research.maxSources': research.maxSources }),
    ...(research.modelRetries !== undefined && { 'research.modelRetries': research.modelRetries }),
    ...(research.toolRetries !== undefined && { 'research.toolRetries': research.toolRetries }),
    ...(research.retryBackoffMs !== undefined && {
      'research.retryBackoffMs': research.retryBackoffMs,
    }),
    ...(research.modelTimeoutMs !== undefined && {
      'research.modelTimeoutMs': research.modelTimeoutMs,
    }),
  };
  const values: Partial<Record<SettingKey, unknown>> = {};
  const vars: Partial<Record<SettingKey, string>> = {};
  for (const def of SETTING_DEFINITIONS) {
    const name = def.env;
    if (!name || !env[name]?.trim() || !(def.key in all)) continue;
    values[def.key] = all[def.key];
    vars[def.key] = name;
  }
  return { values: values as Partial<SettingsValues>, vars };
}

const builtinDefaults = (): SettingsValues =>
  SettingsValuesSchema.parse(
    Object.fromEntries(SETTING_DEFINITIONS.map((d) => [d.key, d.builtin])),
  );

/** Turns renderer input into the stored form: trimmed URLs, empty → null where allowed. */
export function normalizeValue(key: SettingKey, value: unknown): unknown {
  const def = defsByKey.get(key);
  if (!def) return value;
  if (typeof value === 'string' && def.kind === 'url') {
    const trimmed = value.trim();
    if (trimmed === '' && def.nullable) return null;
    return normalizeServerUrl(trimmed, key === 'searxng.url' ? 8080 : 11434);
  }
  if (typeof value === 'string' && def.kind === 'model') return value.trim();
  if (value === '' && def.nullable) return null;
  return value;
}

export function createRuntimeConfig(deps: RuntimeConfigDeps) {
  const { storage } = deps;
  const warn = deps.warn ?? ((message: string) => console.warn(message));
  const builtin = builtinDefaults();
  const environment = environmentDefaults(deps.env);
  const defaults: SettingsValues = { ...builtin, ...environment.values };

  const appliers: ConfigApplier[] = [];
  const listeners = new Set<(change: ConfigChange) => void>();
  let saved = readSaved();
  let values = merge(saved);
  const changedThisSession = new Set<SettingKey>();
  const startSection = values['general.startSection'];
  /** Decrypted secrets, cached in main-process memory only (read on every Ollama request). */
  const secretCache = new Map<SecretSettingKey, string | undefined>();

  /** Saved values from SQLite; invalid ones (e.g. after a schema change) are ignored with a warning. */
  function readSaved(): Partial<SettingsValues> {
    const out: Partial<Record<SettingKey, unknown>> = {};
    for (const entry of storage.settings.list()) {
      if (!entry.key.startsWith(SAVED_PREFIX) || entry.isSecret) continue;
      const key = entry.key.slice(SAVED_PREFIX.length);
      if (!isKey(key)) continue;
      const parsed = SettingsValuesSchema.shape[key].safeParse(entry.value);
      if (parsed.success) out[key] = parsed.data;
      else
        warn(
          `Ignoring the saved value of "${key}": ${parsed.error.issues[0]?.message ?? 'invalid'}`,
        );
    }
    return out as Partial<SettingsValues>;
  }

  function merge(savedValues: Partial<SettingsValues>): SettingsValues {
    return SettingsValuesSchema.parse({ ...defaults, ...savedValues });
  }

  function source(key: SettingKey): SettingSource {
    if (key in saved) return 'saved';
    return environment.vars[key] ? 'environment' : 'default';
  }

  function secretSet(key: SecretSettingKey): boolean {
    return storage.settings.list().some((e) => e.key === SECRET_PREFIX + key && e.isSecret);
  }

  /**
   * Validates a patch on top of the current values.
   * Returns the complete next values, or per-key errors.
   */
  function check(
    patch: Record<string, unknown>,
    options: UpdateOptions = {},
  ): { next: SettingsValues; changed: SettingKey[]; errors: SettingErrors; warnings: string[] } {
    const errors: SettingErrors = {};
    const candidate: Record<string, unknown> = { ...values };
    for (const [rawKey, rawValue] of Object.entries(patch)) {
      if (!isKey(rawKey)) {
        errors[rawKey] = 'Unknown setting.';
        continue;
      }
      if (defsByKey.get(rawKey)?.dedicatedAction && !options.internal) {
        errors[rawKey] = 'This setting can only be changed with its own button.';
        continue;
      }
      const value = normalizeValue(rawKey, rawValue);
      const parsed = SettingsValuesSchema.shape[rawKey].safeParse(value);
      if (!parsed.success) {
        errors[rawKey] = parsed.error.issues[0]?.message ?? 'Invalid value.';
        continue;
      }
      candidate[rawKey] = parsed.data;
    }
    const warnings: string[] = [];
    if (Object.keys(errors).length === 0) {
      // Cross-field rule: "Require HTTPS for remote servers".
      const requireHttps = candidate['security.requireHttpsForRemote'] === true;
      for (const key of ['ollama.baseUrl', 'searxng.url'] as const) {
        const url = candidate[key];
        if (typeof url !== 'string') continue;
        if (violatesHttpsPolicy(url, requireHttps)) {
          const target = key in patch ? key : 'security.requireHttpsForRemote';
          errors[target] =
            `${key === 'ollama.baseUrl' ? 'The Ollama URL' : 'The SearXNG URL'} uses plain HTTP to another computer, which "Require HTTPS for remote servers" does not allow.`;
        } else if (key in patch && url !== values[key]) {
          warnings.push(...connectionAdvice(url).warnings);
        }
      }
    }
    const next = SettingsValuesSchema.parse(Object.keys(errors).length ? values : candidate);
    const changed = SETTING_KEYS.filter(
      (k) => JSON.stringify(next[k]) !== JSON.stringify(values[k]),
    );
    return { next, changed, errors, warnings };
  }

  /**
   * Applies `next` to the running services that depend on a changed key,
   * then runs `persist`. On any failure, services are restored to the
   * previous values and nothing is saved.
   */
  function commit(
    next: SettingsValues,
    changed: readonly SettingKey[],
    persist: () => void,
    applyAll = false,
    /** Runs after a successful save, before listeners are notified. */
    onSaved: () => void = () => undefined,
  ): { ok: true } | { ok: false; message: string } {
    const previous = values;
    const affected = applyAll
      ? appliers
      : appliers.filter((a) => a.keys.some((k) => changed.includes(k)));
    const applied: ConfigApplier[] = [];
    try {
      for (const applier of affected) {
        applier.apply(next, previous);
        applied.push(applier);
      }
      persist();
    } catch (error) {
      for (const applier of applied.reverse()) {
        try {
          applier.apply(previous, next);
        } catch (rollbackError) {
          warn(`Could not restore ${applier.name}: ${String(rollbackError)}`);
        }
      }
      const reason = error instanceof Error ? error.message : String(error);
      return { ok: false, message: `The settings were not changed: ${reason}` };
    }
    values = next;
    onSaved();
    for (const key of changed) changedThisSession.add(key);
    if (changed.length) {
      const event = { changed: [...changed], values };
      for (const listener of listeners) {
        try {
          listener(event);
        } catch (error) {
          warn(`Settings listener failed: ${String(error)}`);
        }
      }
    }
    return { ok: true };
  }

  function savedResult(): SettingsUpdateResult & { status: 'saved' } {
    return { status: 'saved', view: api.view(), changed: [], warnings: [] };
  }

  const api = {
    /** Effective values the app uses now. */
    getSettings: (): SettingsValues => values,

    getSetting: <K extends SettingKey>(key: K): SettingsValues[K] => values[key],

    /** Value a setting falls back to when its saved value is reset. */
    getDefault: <K extends SettingKey>(key: K): SettingsValues[K] => defaults[key],

    /** For the renderer: values, where they come from, and whether secrets are set (never their values). */
    view(): SettingsView {
      return {
        values,
        entries: Object.fromEntries(
          SETTING_KEYS.map((key) => [
            key,
            {
              source: source(key),
              defaultValue: defaults[key] as never,
              envVar: environment.vars[key] ?? null,
            },
          ]),
        ),
        secrets: Object.fromEntries(SECRET_SETTING_KEYS.map((k) => [k, { set: secretSet(k) }])),
        encryptionAvailable: deps.encryptionAvailable(),
        pendingRestart: RESTART_REQUIRED_KEYS.filter((k) => changedThisSession.has(k)),
        startedWith: { startSection },
      };
    },

    validateSettings(
      patch: Record<string, unknown>,
      options: UpdateOptions = {},
    ): SettingsValidateResult {
      const { errors, warnings } = check(patch, options);
      return { ok: Object.keys(errors).length === 0, errors, warnings };
    },

    /** Validates, applies to running services, then saves. All or nothing. */
    updateSettings(
      patch: Record<string, unknown>,
      options: UpdateOptions = {},
    ): SettingsUpdateResult {
      const { next, changed, errors, warnings } = check(patch, options);
      if (Object.keys(errors).length) return { status: 'invalid', errors };
      const explicit = Object.keys(patch).filter(isKey);
      const nextSaved = { ...saved, ...Object.fromEntries(explicit.map((k) => [k, next[k]])) };
      const result = commit(
        next,
        changed,
        () =>
          storage.transaction((repos) => {
            // Explicit values are saved even when equal to the default, so a
            // later change of the environment never silently changes them.
            for (const key of explicit) repos.settings.set(SAVED_PREFIX + key, next[key] as never);
          }),
        false,
        () => (saved = nextSaved as Partial<SettingsValues>),
      );
      if (!result.ok) return { status: 'failed', message: result.message };
      return { ...savedResult(), changed: [...changed], warnings };
    },

    /** Removes the saved value of one setting (falls back to environment/default). */
    resetSetting(key: SettingKey): SettingsUpdateResult {
      return api.resetSettings([key]);
    },

    /** Removes saved values (all when `keys` is omitted). Secrets are not touched. */
    resetSettings(keys?: readonly string[]): SettingsUpdateResult {
      const targets = keys ?? SETTING_KEYS;
      const unknown = targets.filter((k) => !isKey(k));
      if (unknown.length) {
        return {
          status: 'invalid',
          errors: Object.fromEntries(unknown.map((k) => [k, 'Unknown setting.'])),
        };
      }
      const nextSaved = Object.fromEntries(
        Object.entries(saved).filter(([key]) => !targets.includes(key)),
      ) as Partial<Record<SettingKey, unknown>>;
      const next = merge(nextSaved as Partial<SettingsValues>);
      const changed = SETTING_KEYS.filter(
        (k) => JSON.stringify(next[k]) !== JSON.stringify(values[k]),
      );
      const result = commit(
        next,
        changed,
        () =>
          storage.transaction((repos) => {
            for (const key of targets) repos.settings.delete(SAVED_PREFIX + key);
          }),
        false,
        () => (saved = nextSaved as Partial<SettingsValues>),
      );
      if (!result.ok) return { status: 'failed', message: result.message };
      return { ...savedResult(), changed: [...changed], warnings: [] };
    },

    /** Stores a secret encrypted (OS key store), or removes it with null/''. Never returns it. */
    setSecret(key: SecretSettingKey, value: string | null): SettingsUpdateResult {
      const trimmed = value?.trim() ?? '';
      try {
        if (trimmed) {
          if (!deps.encryptionAvailable()) {
            return {
              status: 'failed',
              message:
                'OS encryption is not available, so the token cannot be stored safely. Nothing was saved.',
            };
          }
          if (/\s/.test(trimmed))
            return { status: 'invalid', errors: { [key]: 'The token must not contain spaces.' } };
          storage.settings.setSecret(SECRET_PREFIX + key, trimmed);
          secretCache.set(key, trimmed);
        } else {
          storage.settings.delete(SECRET_PREFIX + key);
          secretCache.set(key, undefined);
        }
      } catch (error) {
        return {
          status: 'failed',
          message: error instanceof Error ? error.message : String(error),
        };
      }
      const view = api.view();
      for (const listener of listeners) listener({ changed: [key], values });
      return { status: 'saved', view, changed: [key], warnings: [] };
    },

    /** Main process only. Never send to the renderer. */
    getSecret(key: SecretSettingKey): string | undefined {
      if (secretCache.has(key)) return secretCache.get(key);
      try {
        const entry = storage.settings
          .list()
          .find((e) => e.key === SECRET_PREFIX + key && e.isSecret);
        const value = entry ? storage.settings.getSecret(SECRET_PREFIX + key) : undefined;
        secretCache.set(key, value);
        return value;
      } catch (error) {
        warn(
          `Could not read secret "${key}": ${error instanceof Error ? error.message : String(error)}`,
        );
        return undefined;
      }
    },

    /** Registers a running service; it is applied once with the current values. */
    register(applier: ConfigApplier): void {
      applier.apply(values, values);
      appliers.push(applier);
    },

    /** Re-reads saved values from SQLite and re-applies them to every service. */
    reloadRuntimeConfiguration(): SettingsUpdateResult {
      const nextSaved = readSaved();
      const next = merge(nextSaved);
      const changed = SETTING_KEYS.filter(
        (k) => JSON.stringify(next[k]) !== JSON.stringify(values[k]),
      );
      const result = commit(
        next,
        changed,
        () => undefined,
        true,
        () => (saved = nextSaved),
      );
      if (!result.ok) return { status: 'failed', message: result.message };
      return { ...savedResult(), changed: [...changed], warnings: [] };
    },

    /** Called after every successful change. Returns an unsubscribe function. */
    onChange(listener: (change: ConfigChange) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return api;
}

export type RuntimeConfig = ReturnType<typeof createRuntimeConfig>;
