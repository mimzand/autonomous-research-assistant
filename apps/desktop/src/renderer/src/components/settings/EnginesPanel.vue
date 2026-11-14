<script setup lang="ts">
import { type SettingKey } from '@rka/shared';
import { useSettings } from '../../composables/useSettings';
import { optionsWithActive, webSearchAvailability } from '../../lib/settings';
import SettingsForm from './SettingsForm.vue';

/** Legacy / Google ADK selection for Chat and Research (independent), and web search in Chat. */
const KEYS: SettingKey[] = ['engine.chat', 'engine.research', 'chat.webSearch'];
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
          restart). Research never lets the model call tools. Unless Web search in Chat is turned on
          (off by default), Chat does not either; when it is on, Chat may run web searches with
          either engine, with fixed limits.
        </p>
      </template>
      <template #after="{ setting }">
        <p
          v-if="view && setting === 'chat.webSearch'"
          class="note"
          :data-tone="webSearchAvailability(view.values).tone"
          data-testid="web-search-availability"
        >
          {{ webSearchAvailability(view.values).text }}
        </p>
        <ul v-else-if="view" class="options" :data-testid="`engine-options-${setting}`">
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
.note {
  margin: 0 0 10px;
  font-size: 0.85rem;
  padding: 4px 8px;
  border-radius: 6px;
}
.note[data-tone='ok'] {
  background: var(--selected);
}
.note[data-tone='warn'] {
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
