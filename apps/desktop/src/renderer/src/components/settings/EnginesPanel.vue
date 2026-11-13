<script setup lang="ts">
import { type SettingKey } from '@rka/shared';
import { useSettings } from '../../composables/useSettings';
import { optionsWithActive } from '../../lib/settings';
import SettingsForm from './SettingsForm.vue';

/** Legacy / Google ADK selection for Chat and Research (independent). */
const KEYS: SettingKey[] = ['engine.chat', 'engine.research'];
const { view } = useSettings();
</script>

<template>
  <div class="panel" data-testid="engines-panel">
    <SettingsForm :keys="KEYS" title="Agent engines" testid="engines-form">
      <template #intro>
        <p class="muted small">
          Both engines use the same Ollama server, model and settings. Legacy is the default. Chat
          uses the selected engine for new messages; Research uses it for new tasks, and every task
          keeps the engine it was created with (also when resumed, retried or recovered after a
          restart). The model never calls tools on its own with either engine.
        </p>
      </template>
      <template #after="{ setting }">
        <ul v-if="view" class="options" :data-testid="`engine-options-${setting}`">
          <li
            v-for="o in optionsWithActive(view, setting)"
            :key="o.value"
            :data-active="o.active || undefined"
            :data-testid="`engine-option-${setting}-${o.value}`"
          >
            <strong>{{ o.label }}</strong>
            <span class="muted">— {{ o.description }}</span>
            <span v-if="o.active" class="pill" data-tone="ok">Active</span>
          </li>
        </ul>
      </template>
    </SettingsForm>
  </div>
</template>

<style scoped>
.panel {
  display: grid;
  gap: 16px;
  min-width: 0;
}
.options {
  list-style: none;
  margin: 0;
  padding: 0 0 10px;
  display: grid;
  gap: 4px;
  font-size: 0.9rem;
}
.options li {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 4px 8px;
  border-radius: 6px;
}
.options li[data-active] {
  background: var(--selected);
}
.pill {
  font-size: 0.8rem;
  padding: 1px 10px;
  border-radius: 999px;
  color: var(--tone-fg);
  background: var(--tone-bg);
}
.muted {
  color: var(--muted);
}
.small {
  font-size: 0.85rem;
}
</style>
