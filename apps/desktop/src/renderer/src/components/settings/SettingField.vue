<script setup lang="ts">
import { type SettingDefinition, type SettingsView } from '@rka/shared';
import { computed } from 'vue';
import { APPLIES_TEXT, describeValue, origin } from '../../lib/settings';

/** One setting: label, input, where the value comes from, and its error. */
const props = defineProps<{
  def: SettingDefinition;
  view: SettingsView;
  modelValue: string | boolean;
  error?: string | null;
  dirty?: boolean;
  /** For `model` fields: installed models to choose from. */
  models?: readonly string[];
  disabled?: boolean;
}>();
const emit = defineEmits<{
  'update:modelValue': [value: string | boolean];
  reset: [];
}>();

const id = computed(() => `setting-${props.def.key.replace(/\W/g, '-')}`);
const badge = computed(() => origin(props.view, props.def.key));
const defaultText = computed(() =>
  describeValue(props.def, props.view.entries[props.def.key]?.defaultValue),
);
const hint = computed(() => {
  const d = props.def;
  if (d.min === undefined || d.max === undefined) return null;
  // The unit once, at the end ("1 – 131,072 tokens"); times and sizes keep their own units.
  const low =
    d.unit === 'ms' || d.unit === 'bytes' ? describeValue(d, d.min) : d.min.toLocaleString('en-US');
  return `${low} – ${describeValue(d, d.max)}`;
});
const modelOptions = computed(() => {
  const list = [...(props.models ?? [])];
  const current = String(props.modelValue);
  if (current && !list.includes(current)) list.unshift(current);
  return list;
});
const onInput = (event: Event) =>
  emit('update:modelValue', (event.target as HTMLInputElement | HTMLSelectElement).value);
</script>

<template>
  <div class="field" :data-testid="`field-${def.key}`" :data-dirty="dirty || undefined">
    <div class="head">
      <label :for="id">{{ def.label }}</label>
      <span class="badge" :data-tone="badge.tone" :title="badge.title" data-testid="origin">
        {{ badge.label }}
      </span>
      <span v-if="dirty" class="badge" data-tone="warn">Unsaved</span>
    </div>
    <div class="control">
      <label v-if="def.kind === 'boolean'" class="switch">
        <input
          :id="id"
          type="checkbox"
          :checked="Boolean(modelValue)"
          :disabled="disabled"
          @change="emit('update:modelValue', ($event.target as HTMLInputElement).checked)"
        />
        <span>{{ modelValue ? 'On' : 'Off' }}</span>
      </label>
      <select
        v-else-if="def.kind === 'select'"
        :id="id"
        :value="String(modelValue)"
        :disabled="disabled"
        @change="onInput"
      >
        <option v-for="o in def.options" :key="String(o.value)" :value="String(o.value)">
          {{ o.label }}
        </option>
      </select>
      <select
        v-else-if="def.kind === 'model' && modelOptions.length"
        :id="id"
        :value="String(modelValue)"
        :disabled="disabled"
        @change="onInput"
      >
        <option v-for="name in modelOptions" :key="name" :value="name">
          {{ name }}{{ models && !models.includes(name) ? ' (not installed)' : '' }}
        </option>
      </select>
      <input
        v-else
        :id="id"
        :type="def.kind === 'integer' || def.kind === 'number' ? 'number' : 'text'"
        :inputmode="
          def.kind === 'integer' ? 'numeric' : def.kind === 'number' ? 'decimal' : undefined
        "
        :min="def.min"
        :max="def.max"
        :step="def.step ?? (def.kind === 'number' ? 'any' : undefined)"
        :placeholder="def.nullable ? def.nullLabel : undefined"
        :value="String(modelValue)"
        :disabled="disabled || def.dedicatedAction"
        :aria-invalid="error ? 'true' : undefined"
        :aria-describedby="`${id}-desc`"
        spellcheck="false"
        autocomplete="off"
        @input="onInput"
      />
      <button
        v-if="badge.label === 'Customized'"
        type="button"
        class="link"
        :title="`Reset to ${defaultText}`"
        :data-testid="`reset-${def.key}`"
        :disabled="disabled"
        @click="emit('reset')"
      >
        Reset
      </button>
    </div>
    <p :id="`${id}-desc`" class="desc">
      {{ def.description }}
      <span class="meta">
        Default: {{ defaultText }}<template v-if="hint"> · Range {{ hint }}</template> ·
        {{ APPLIES_TEXT[def.applies] }}
      </span>
    </p>
    <p v-if="error" class="error" role="alert" data-testid="field-error">{{ error }}</p>
  </div>
</template>

<style scoped>
.field {
  display: grid;
  gap: 4px;
  padding: 10px 0;
  border-bottom: 1px solid var(--border);
}
.field:last-child {
  border-bottom: none;
}
.field[data-dirty] {
  border-left: 3px solid var(--warn);
  padding-left: 10px;
  margin-left: -13px;
}
.head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.head label {
  font-weight: 600;
}
.badge {
  font-size: 0.72rem;
  padding: 1px 8px;
  border-radius: 999px;
  color: var(--tone-fg, var(--muted));
  background: var(--tone-bg, var(--bubble));
}
.badge[data-tone='accent'] {
  color: var(--accent);
  background: var(--selected);
}
.control {
  display: flex;
  align-items: center;
  gap: 10px;
}
.control input:not([type='checkbox']),
.control select {
  width: min(460px, 100%);
}
.control input[aria-invalid='true'] {
  border-color: var(--error);
}
.switch {
  display: inline-flex;
  gap: 8px;
  align-items: center;
}
.desc {
  margin: 0;
  font-size: 0.85rem;
  color: var(--muted);
}
.meta {
  display: block;
  font-size: 0.78rem;
}
.error {
  margin: 0;
  color: var(--error);
  font-size: 0.85rem;
}
</style>
