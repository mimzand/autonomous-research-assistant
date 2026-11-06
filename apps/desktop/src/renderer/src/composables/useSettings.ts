import { type SettingKey, type SettingsUpdateResult, type SettingsView } from '@rka/shared';
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue';

/*
 * One shared settings state for the window: loaded once, refreshed by the
 * main process's "settings changed" events (also from other windows), and a
 * small notification queue for success/failure messages.
 */

export interface Notice {
  readonly id: number;
  readonly tone: 'ok' | 'error' | 'warn' | 'info';
  readonly text: string;
}

const view = shallowRef<SettingsView | null>(null);
const loading = ref(false);
const loadError = ref<string | null>(null);
const notices = ref<Notice[]>([]);
let nextId = 1;
let subscribers = 0;
let unsubscribe: (() => void) | null = null;
const changeListeners = new Set<(changed: readonly string[]) => void>();

async function load(): Promise<void> {
  loading.value = true;
  try {
    view.value = await window.api.settings.get();
    loadError.value = null;
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : String(error);
  } finally {
    loading.value = false;
  }
}

export function notify(
  tone: Notice['tone'],
  text: string,
  ms = tone === 'error' ? 8000 : 4000,
): void {
  const id = nextId++;
  notices.value = [...notices.value, { id, tone, text }].slice(-4);
  setTimeout(() => dismiss(id), ms);
}

export function dismiss(id: number): void {
  notices.value = notices.value.filter((n) => n.id !== id);
}

/** Handles a save/reset result: updates the state and notifies. Returns the field errors, if any. */
export function handleResult(
  result: SettingsUpdateResult | { status: 'cancelled' },
  success: string,
): Record<string, string> {
  if (result.status === 'saved') {
    view.value = result.view;
    notify('ok', result.changed.length ? success : 'No changes.');
    for (const warning of result.warnings) notify('warn', warning, 10_000);
    return {};
  }
  if (result.status === 'invalid') {
    notify('error', 'Not saved: fix the highlighted fields.');
    return result.errors;
  }
  if (result.status === 'failed') notify('error', result.message);
  return {};
}

/** Subscribes to "settings changed" for as long as a component using it is mounted. */
export function useSettings(onChanged?: (changed: readonly string[]) => void) {
  onMounted(() => {
    if (onChanged) changeListeners.add(onChanged);
    subscribers++;
    if (subscribers === 1) {
      unsubscribe = window.api.settings.onChanged((event) => {
        view.value = event.view;
        for (const listener of changeListeners) listener(event.changed);
      });
    }
    if (!view.value) void load();
  });
  onBeforeUnmount(() => {
    if (onChanged) changeListeners.delete(onChanged);
    subscribers--;
    if (subscribers === 0) {
      unsubscribe?.();
      unsubscribe = null;
    }
  });
  return {
    view: computed(() => view.value),
    values: computed(() => view.value?.values ?? null),
    loading: computed(() => loading.value),
    loadError: computed(() => loadError.value),
    notices: computed(() => notices.value),
    load,
    async save(patch: Record<string, unknown>, success = 'Settings saved.') {
      return handleResult(await window.api.settings.update(patch), success);
    },
    async reset(keys: SettingKey[] | undefined, success = 'Reset to default.') {
      return handleResult(await window.api.settings.reset(keys), success);
    },
  };
}
