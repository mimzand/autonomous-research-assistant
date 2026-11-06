<script setup lang="ts">
import { SETTINGS_CATEGORIES, SETTINGS_CATEGORY_LABELS, type SettingsCategory } from '@rka/shared';
import { ref } from 'vue';
import ModelsPanel from '../components/settings/ModelsPanel.vue';
import OllamaPanel from '../components/settings/OllamaPanel.vue';
import ResearchPanel from '../components/settings/ResearchPanel.vue';
import SecurityPanel from '../components/settings/SecurityPanel.vue';
import SettingsForm from '../components/settings/SettingsForm.vue';
import StoragePanel from '../components/settings/StoragePanel.vue';
import ErrorBanner from '../components/ui/ErrorBanner.vue';
import PageHeader from '../components/ui/PageHeader.vue';
import { dismiss, useSettings } from '../composables/useSettings';
import { definitionsFor } from '../lib/settings';

/** Settings: one panel per category. Changes apply without restarting the app. */
const { view, loading, loadError, notices, load, reset } = useSettings();
const category = ref<SettingsCategory>('ollama');

const DESCRIPTIONS: Record<SettingsCategory, string> = {
  general: 'Start page and startup checks.',
  models: 'Installed models, the active model and generation options.',
  ollama: 'Server address, connection test and access token.',
  research: 'SearXNG, fetching limits and research defaults.',
  storage: 'Database information and backups.',
  security: 'Remote connection policy and secrets.',
  advanced: 'Timeouts and retries.',
};
const keysFor = (c: SettingsCategory) => definitionsFor(c).map((d) => d.key);

async function resetAll(): Promise<void> {
  if (window.confirm('Reset every setting to its default value? Saved access tokens are kept.')) {
    await reset(undefined, 'All settings reset to defaults.');
  }
}
</script>

<template>
  <section class="page" data-testid="settings-page">
    <PageHeader title="Settings" subtitle="Changes apply to the running app; no restart is needed.">
      <template #actions>
        <button
          type="button"
          class="secondary"
          data-testid="settings-reset-all"
          :disabled="!view"
          @click="resetAll"
        >
          Reset all
        </button>
      </template>
    </PageHeader>

    <div class="notices" aria-live="polite">
      <div
        v-for="n in notices"
        :key="n.id"
        class="notice"
        :data-tone="n.tone"
        :role="n.tone === 'error' ? 'alert' : 'status'"
        data-testid="settings-notice"
      >
        <span>{{ n.text }}</span>
        <button type="button" class="link" aria-label="Dismiss" @click="dismiss(n.id)">✕</button>
      </div>
    </div>

    <ErrorBanner v-if="loadError" :message="loadError" @retry="load()" />
    <div v-else-if="!view" class="loading" role="status">
      {{ loading ? 'Loading settings…' : '' }}
    </div>

    <div v-else class="layout">
      <nav class="categories" aria-label="Settings categories">
        <button
          v-for="c in SETTINGS_CATEGORIES"
          :key="c"
          type="button"
          :aria-current="category === c ? 'page' : undefined"
          :data-testid="`settings-cat-${c}`"
          @click="category = c"
        >
          <span>{{ SETTINGS_CATEGORY_LABELS[c] }}</span>
          <small>{{ DESCRIPTIONS[c] }}</small>
        </button>
      </nav>

      <div class="content">
        <p v-if="view.pendingRestart.length" class="notice" data-tone="warn" role="status">
          Restart the app to apply: {{ view.pendingRestart.join(', ') }}
        </p>
        <h3 class="category-title">{{ SETTINGS_CATEGORY_LABELS[category] }}</h3>
        <OllamaPanel v-if="category === 'ollama'" />
        <ModelsPanel v-else-if="category === 'models'" />
        <ResearchPanel v-else-if="category === 'research'" />
        <StoragePanel v-else-if="category === 'storage'" />
        <SecurityPanel v-else-if="category === 'security'" />
        <SettingsForm v-else :key="category" :keys="keysFor(category)" :testid="`${category}-form`">
          <template v-if="category === 'general'" #intro>
            <p class="muted">
              The app started on <strong>{{ view.startedWith.startSection }}</strong
              >. No setting in this app needs a restart; settings marked "next start" are only read
              when the app opens.
            </p>
          </template>
        </SettingsForm>
      </div>
    </div>
  </section>
</template>

<style scoped>
.page {
  display: grid;
  gap: 16px;
  align-content: start;
}
.layout {
  display: grid;
  grid-template-columns: 230px minmax(0, 1fr);
  gap: 20px;
  align-items: start;
}
.categories {
  display: grid;
  gap: 4px;
  position: sticky;
  top: 0;
}
.categories button {
  display: grid;
  text-align: left;
  border: none;
  background: none;
  padding: 8px 10px;
  border-radius: 8px;
}
.categories button[aria-current='page'] {
  background: var(--selected);
  color: var(--accent);
  font-weight: 600;
}
.categories small {
  color: var(--muted);
  font-weight: 400;
}
.content {
  display: grid;
  gap: 16px;
  min-width: 0;
}
.content > :deep(*) {
  min-width: 0;
}
.category-title {
  margin: 0;
  font-size: 1.1rem;
}
.notices {
  position: fixed;
  right: 20px;
  bottom: 20px;
  display: grid;
  gap: 8px;
  z-index: 10;
  max-width: min(460px, 90vw);
}
.notice {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 12px;
  border-radius: 8px;
  color: var(--tone-fg);
  background: var(--surface);
  box-shadow:
    inset 0 0 0 999px var(--tone-bg),
    0 4px 14px rgba(0, 0, 0, 0.12);
  border: 1px solid var(--tone-fg);
}
.loading {
  padding: 48px;
  text-align: center;
  color: var(--muted);
}
.muted {
  color: var(--muted);
}
@media (max-width: 1000px) {
  .layout {
    grid-template-columns: 1fr;
  }
  .categories {
    position: static;
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  }
  .categories small {
    display: none;
  }
}
</style>
