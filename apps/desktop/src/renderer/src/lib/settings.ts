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
  tone: 'neutral' | 'info' | 'accent';
  label: string;
  title: string;
}

/** Badge telling whether a value is the default, from the environment, or customized. */
export function origin(view: SettingsView, key: SettingKey): Origin {
  const entry = view.entries[key];
  if (!entry || entry.source === 'default') {
    return { tone: 'neutral', label: 'Default', title: 'Built-in default value.' };
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
