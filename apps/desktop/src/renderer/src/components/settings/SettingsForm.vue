<script setup lang="ts">
import { type SettingKey } from '@rka/shared';
import { computed, reactive, ref, watch } from 'vue';
import { useSettings } from '../../composables/useSettings';
import { buildPatch, definition, dirtyKeys, toInput } from '../../lib/settings';
import SettingField from './SettingField.vue';

/**
 * Editable group of settings with Save / Reset. Edits stay local until Save;
 * the main process validates again and either applies everything or nothing.
 */
const props = defineProps<{
  keys: readonly SettingKey[];
  title?: string;
  /** Installed models for `model` fields. */
  models?: readonly string[];
  testid?: string;
}>();
const emit = defineEmits<{ draft: [key: SettingKey, value: string | boolean] }>();

const { view, save, reset } = useSettings();
const drafts = reactive<Record<string, string | boolean>>({});
const errors = ref<Record<string, string>>({});
const warnings = ref<string[]>([]);
const busy = ref(false);

const current = (key: SettingKey): string | boolean => {
  const value = view.value?.values[key];
  return definition(key).kind === 'boolean' ? Boolean(value) : toInput(value);
};

// Saved values replace untouched fields (also after changes from other windows).
watch(
  () => view.value?.values,
  (values, old) => {
    if (!values) return;
    for (const key of props.keys) {
      const untouched =
        drafts[key] === undefined ||
        (old && JSON.stringify(drafts[key]) === JSON.stringify(current(key)));
      const changedHere = old && JSON.stringify(values[key]) !== JSON.stringify(old[key]);
      if (untouched || changedHere) drafts[key] = current(key);
    }
  },
  { immediate: true },
);

const dirty = computed(() => (view.value ? dirtyKeys(props.keys, drafts, view.value.values) : []));
const customized = computed(() =>
  props.keys.filter((k) => view.value?.entries[k]?.source === 'saved'),
);

let validateTimer: ReturnType<typeof setTimeout> | undefined;
function onEdit(key: SettingKey, value: string | boolean): void {
  drafts[key] = value;
  emit('draft', key, value);
  const { [key]: _removed, ...rest } = errors.value;
  errors.value = rest;
  clearTimeout(validateTimer);
  // Live validation by the main process (nothing is saved).
  validateTimer = setTimeout(() => void validate(), 400);
}

async function validate(): Promise<boolean> {
  const { patch, errors: local } = buildPatch(dirty.value, drafts);
  if (Object.keys(local).length) {
    errors.value = { ...errors.value, ...local };
    return false;
  }
  if (!Object.keys(patch).length) {
    warnings.value = [];
    return true;
  }
  const result = await window.api.settings.validate(patch);
  errors.value = { ...result.errors };
  warnings.value = result.warnings;
  return result.ok;
}

async function onSave(): Promise<void> {
  busy.value = true;
  try {
    if (!(await validate())) return;
    const { patch } = buildPatch(dirty.value, drafts);
    errors.value = await save(patch, props.title ? `${props.title}: saved.` : 'Settings saved.');
    if (!Object.keys(errors.value).length) warnings.value = [];
  } catch (error) {
    errors.value = { _: error instanceof Error ? error.message : String(error) };
  } finally {
    busy.value = false;
  }
}

function onDiscard(): void {
  for (const key of props.keys) drafts[key] = current(key);
  errors.value = {};
  warnings.value = [];
}

async function onReset(keys: SettingKey[]): Promise<void> {
  busy.value = true;
  try {
    await reset(keys);
    for (const key of keys) drafts[key] = current(key);
    errors.value = {};
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section v-if="view" class="card form" :data-testid="testid ?? 'settings-form'">
    <h3 v-if="title">{{ title }}</h3>
    <slot name="intro" />
    <template v-for="key in keys" :key="key">
      <SettingField
        :def="definition(key)"
        :view="view"
        :model-value="drafts[key] ?? ''"
        :error="errors[key]"
        :dirty="dirty.includes(key)"
        :models="models"
        :disabled="busy"
        @update:model-value="onEdit(key, $event)"
        @reset="onReset([key])"
      />
      <slot name="after" :setting="key" />
    </template>
    <ul v-if="warnings.length" class="warnings" data-tone="warn">
      <li v-for="w in warnings" :key="w">{{ w }}</li>
    </ul>
    <p v-if="errors['_']" class="error" role="alert">{{ errors['_'] }}</p>
    <div class="actions">
      <button
        type="button"
        class="primary"
        data-testid="settings-save"
        :disabled="busy || !dirty.length || Object.keys(errors).length > 0"
        @click="onSave"
      >
        {{ busy ? 'Saving…' : 'Save' }}
      </button>
      <button type="button" :disabled="busy || !dirty.length" @click="onDiscard">
        Discard changes
      </button>
      <button
        type="button"
        class="secondary"
        data-testid="settings-reset-section"
        :disabled="busy || !customized.length"
        :title="
          customized.length ? 'Remove the saved values in this section' : 'Nothing customized'
        "
        @click="onReset(customized)"
      >
        Reset section to defaults
      </button>
    </div>
  </section>
</template>

<style scoped>
.form {
  padding: 4px 16px 14px;
}
h3 {
  margin: 12px 0 0;
  font-size: 1rem;
}
.actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  padding-top: 12px;
}
.warnings {
  margin: 10px 0 0;
  padding: 8px 12px 8px 28px;
  border-radius: 8px;
  color: var(--tone-fg);
  background: var(--tone-bg);
}
.error {
  color: var(--error);
}
</style>
