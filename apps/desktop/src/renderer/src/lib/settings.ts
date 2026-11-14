import {
  SETTING_DEFINITION_BY_KEY,
  SETTING_DEFINITIONS,
  type SettingDefinition,
  type SettingKey,
  type SettingsCategory,
  type SettingsValues,
  type SettingsView,
} from '@rka/shared';

/*
 * Pure helpers for the Settings page: turning values into text fields and
 * back, describing where a value comes from, and tracking unsaved edits.
 * All real validation happens in the main process; these only shape input.
 */

export const definitionsFor = (category: SettingsCategory): readonly SettingDefinition[] =>
  SETTING_DEFINITIONS.filter((d) => d.category === category);

export const definition = (key: SettingKey): SettingDefinition => {
  const def = SETTING_DEFINITION_BY_KEY.get(key);
  if (!def) throw new Error(`Unknown setting ${key}`);
  return def;
};

/** Text shown in an input for a stored value. */
export function toInput(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

/** Parses an input string into the value sent to main. Returns an error message for obvious mistakes. */
export function fromInput(
  def: SettingDefinition,
  raw: string | boolean,
): { ok: true; value: unknown } | { ok: false; error: string } {
  if (def.kind === 'boolean') return { ok: true, value: Boolean(raw) };
  const text = String(raw).trim();
  if (text === '') {
    return def.nullable ? { ok: true, value: null } : { ok: false, error: 'A value is required.' };
  }
  if (def.kind === 'integer' || def.kind === 'number') {
    const value = Number(text.replace(',', '.'));
    if (!Number.isFinite(value)) return { ok: false, error: 'Enter a number.' };
    if (def.kind === 'integer' && !Number.isInteger(value))
      return { ok: false, error: 'Enter a whole number.' };
    return { ok: true, value };
  }
  if (def.kind === 'select') {
    const option = def.options?.find((o) => String(o.value) === text);
    return option ? { ok: true, value: option.value } : { ok: false, error: 'Choose an option.' };
  }
  return { ok: true, value: text };
}

const fmt = new Intl.NumberFormat('en-US');

/** Human-readable value, e.g. "300 s", "15 MB", "Model default". */
export function describeValue(def: SettingDefinition, value: unknown): string {
  if (value === null || value === undefined) return def.nullLabel ?? 'Not set';
  if (def.kind === 'boolean') return value ? 'On' : 'Off';
  if (def.kind === 'select') {
    return def.options?.find((o) => o.value === value)?.label ?? String(value);
  }
  if (typeof value === 'number') {
    switch (def.unit) {
      case 'ms':
        return value >= 1000 && value % 1000 === 0
          ? `${fmt.format(value / 1000)} s`
          : `${fmt.format(value)} ms`;
      case 'bytes':
        return value >= 1024 * 1024
          ? `${fmt.format(Math.round((value / (1024 * 1024)) * 10) / 10)} MB`
          : `${fmt.format(Math.round(value / 1024))} KB`;
      case 'tokens':
        return `${fmt.format(value)} tokens`;
      case 'characters':
        return `${fmt.format(value)} characters`;
      case 'pages':
        return `${fmt.format(value)} pages`;
      default:
        return fmt.format(value);
    }
  }
  return String(value);
}

export interface Origin {
  tone: 'neutral' | 'info' | 'accent' | 'warn';
  label: string;
  title: string;
}

/** Badge telling whether a value is the default, from the environment, or customized. */
export function origin(view: SettingsView, key: SettingKey): Origin {
  const entry = view.entries[key];
  if (!entry || entry.source === 'default') {
    return { tone: 'neutral', label: 'Default', title: 'Built-in default value.' };
  }
  if (entry.overridden) {
    return {
      tone: 'warn',
      label: `Overridden by ${entry.envVar ?? 'environment'}`,
      title: `Set by the environment variable ${entry.envVar ?? ''}, which takes precedence over Settings. Remove it and restart the app to use or change the value here.`,
    };
  }
  if (entry.source === 'environment') {
    return {
      tone: 'info',
      label: `From ${entry.envVar ?? 'environment'}`,
      title: `Set by the environment variable ${entry.envVar ?? ''} (.env or settings.env). Saving here overrides it.`,
    };
  }
  return {
    tone: 'accent',
    label: 'Customized',
    title: `Saved in Settings. Reset returns to ${describeValue(definition(key), entry.defaultValue)}.`,
  };
}

export const APPLIES_TEXT = {
  immediately: 'Applies immediately',
  'new-tasks': 'Applies to new chats and tasks; running tasks keep their settings',
  'next-start': 'Applies the next time the app starts',
} as const;

/** Keys whose draft text differs from the saved value. */
export function dirtyKeys(
  keys: readonly SettingKey[],
  drafts: Readonly<Record<string, string | boolean>>,
  values: SettingsValues,
): SettingKey[] {
  return keys.filter((key) => {
    const draft = drafts[key];
    if (draft === undefined) return false;
    const parsed = fromInput(definition(key), draft);
    if (!parsed.ok) return true;
    return JSON.stringify(parsed.value) !== JSON.stringify(values[key]);
  });
}

/** Builds a patch from the drafts of `keys`, or the first local input errors. */
export function buildPatch(
  keys: readonly SettingKey[],
  drafts: Readonly<Record<string, string | boolean>>,
): { patch: Record<string, unknown>; errors: Record<string, string> } {
  const patch: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const key of keys) {
    const draft = drafts[key];
    if (draft === undefined) continue;
    const parsed = fromInput(definition(key), draft);
    if (parsed.ok) patch[key] = parsed.value;
    else errors[key] = parsed.error;
  }
  return { patch, errors };
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—';
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

/**
 * The options of a `select` setting with their explanations, marking the one
 * in effect (the saved value, or the environment/built-in default).
 */
export function optionsWithActive(
  view: SettingsView,
  key: SettingKey,
): { value: string; label: string; description: string; active: boolean }[] {
  const current = String(view.values[key]);
  return (definition(key).options ?? []).map((o) => ({
    value: String(o.value),
    label: o.label,
    description: o.description ?? '',
    active: String(o.value) === current,
  }));
}

/**
 * Environment override state of a setting (server URL, model, engines): when
 * locked, the field shows the active value read-only; the saved value, if
 * any, is shown separately as the inactive fallback.
 */
export function overrideState(
  view: SettingsView,
  key: SettingKey,
): {
  locked: boolean;
  /** Shown under a locked field. */
  note: string | null;
  /** The saved value that applies again once the override is removed. */
  savedFallback: string | null;
  /** The variable is set but invalid (not applied). */
  envError: string | null;
} {
  const entry = view.entries[key];
  const locked = entry?.overridden === true;
  const def = definition(key);
  return {
    locked,
    note: locked
      ? `Active value from the environment variable ${entry?.envVar ?? ''}. To change it here, remove the variable and restart the app.`
      : null,
    savedFallback:
      locked && entry && 'savedValue' in entry && entry.savedValue !== undefined
        ? describeValue(def, entry.savedValue)
        : null,
    envError: entry?.envError ?? null,
  };
}

/** Where an effective value comes from, in words ("OLLAMA_HOST", "saved in Settings", "default"). */
export function sourceText(view: SettingsView, key: SettingKey): string {
  const entry = view.entries[key];
  if (!entry || entry.source === 'default') return 'default';
  if (entry.source === 'saved') return 'saved in Settings';
  return entry.envVar ?? 'environment';
}

/** The effective server URL and model together, with their sources. */
export function effectiveConnection(view: SettingsView) {
  return {
    url: view.values['ollama.baseUrl'],
    urlSource: sourceText(view, 'ollama.baseUrl'),
    model: view.values['model.name'],
    modelSource: sourceText(view, 'model.name'),
  };
}

/**
 * Whether "Web search in Chat" is in effect (Phase 8.2), from the effective
 * values: it needs the setting and a SearXNG URL (Legacy and ADK Chat).
 */
export function webSearchAvailability(values: SettingsView['values']): {
  active: boolean;
  tone: 'ok' | 'warn' | 'muted';
  text: string;
} {
  if (!values['chat.webSearch']) {
    return {
      active: false,
      tone: 'muted',
      text: 'Off: Chat answers without searching the web, and the model cannot call tools.',
    };
  }
  const url = values['searxng.url'];
  if (!url) {
    return {
      active: false,
      tone: 'warn',
      text: 'On, but inactive: set the SearXNG URL in Research & Web Search.',
    };
  }
  let origin = url;
  try {
    origin = new URL(url).origin;
  } catch {
    // Shown as entered.
  }
  return {
    active: true,
    tone: 'ok',
    text: `Active for Chat (Legacy and Google ADK). Search queries are sent to ${origin} and possibly to the search engines it uses.`,
  };
}
