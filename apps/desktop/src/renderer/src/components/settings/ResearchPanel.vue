<script setup lang="ts">
import { type ConnectionTestResult, type SettingKey } from '@rka/shared';
import { onMounted, ref } from 'vue';
import { notify } from '../../composables/useSettings';
import { formatDateTime } from '../../lib/format';
import SettingsForm from './SettingsForm.vue';

/** SearXNG and web/research limits, with a connection test. */
const SEARCH: SettingKey[] = [
  'searxng.url',
  'searxng.safeSearch',
  'web.searchTimeoutMs',
  'research.resultsPerQuery',
];
const FETCH: SettingKey[] = [
  'web.fetchTimeoutMs',
  'web.maxDownloadBytes',
  'web.maxTextChars',
  'web.maxPdfPages',
];
const TASKS: SettingKey[] = ['research.maxQuestions', 'research.maxSources'];

const test = ref<ConnectionTestResult | null>(null);
const testing = ref(false);
const draftUrl = ref<string | null>(null);

async function runTest(): Promise<void> {
  testing.value = true;
  try {
    test.value = await window.api.settings.testSearxng(draftUrl.value ?? undefined);
  } catch (error) {
    notify('error', error instanceof Error ? error.message : String(error));
  } finally {
    testing.value = false;
  }
}
onMounted(runTest);
</script>

<template>
  <div class="panel" data-testid="research-panel">
    <SettingsForm
      :keys="SEARCH"
      title="Web search (SearXNG)"
      testid="search-form"
      @draft="(key, value) => key === 'searxng.url' && (draftUrl = String(value))"
    >
      <template #after="{ setting }">
        <div v-if="setting === 'searxng.url'" class="status" data-testid="searxng-status">
          <button type="button" data-testid="searxng-test" :disabled="testing" @click="runTest">
            {{ testing ? 'Testing…' : 'Test connection' }}
          </button>
          <template v-if="test">
            <span
              class="pill"
              :data-tone="test.ok ? 'ok' : test.code === 'not-configured' ? 'neutral' : 'error'"
            >
              {{
                test.ok
                  ? 'Reachable'
                  : test.code === 'not-configured'
                    ? 'Not configured'
                    : 'Not reachable'
              }}
            </span>
            <span v-if="test.ok" class="muted">
              {{ test.url }} · {{ test.latencyMs }} ms · {{ formatDateTime(test.checkedAt) }}
            </span>
            <span v-else class="error" data-testid="searxng-error">
              {{ test.error }}<template v-if="test.hint"> — {{ test.hint }}</template>
            </span>
          </template>
          <ul v-if="test?.warnings.length" class="warnings" data-tone="warn">
            <li v-for="w in test.warnings" :key="w">{{ w }}</li>
          </ul>
        </div>
      </template>
      <template #intro>
        <p class="muted small">
          No API key is needed. SearXNG must allow JSON output (<code
            >search: formats: [html, json]</code
          >
          in its settings.yml). The test uses the address in the field without saving it.
        </p>
      </template>
    </SettingsForm>
    <SettingsForm :keys="FETCH" title="Fetching and extraction" testid="fetch-form" />
    <SettingsForm :keys="TASKS" title="Research task defaults" testid="tasks-form" />
  </div>
</template>

<style scoped>
.panel {
  display: grid;
  gap: 16px;
  min-width: 0;
}
.panel > * {
  min-width: 0;
}
.status {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 0 0 10px;
}
.pill {
  font-size: 0.8rem;
  padding: 1px 10px;
  border-radius: 999px;
  color: var(--tone-fg);
  background: var(--tone-bg);
}
.warnings {
  width: 100%;
  margin: 0;
  padding: 8px 12px 8px 28px;
  border-radius: 8px;
  color: var(--tone-fg);
  background: var(--tone-bg);
}
.muted {
  color: var(--muted);
}
.small {
  font-size: 0.85rem;
}
.error {
  color: var(--error);
}
</style>
