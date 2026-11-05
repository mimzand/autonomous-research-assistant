<script setup lang="ts">
import { type SearchHealth, type ToolSearchResult } from '@rka/shared';
import { computed, onMounted, ref } from 'vue';
import { formatMs, newRequestId, resultSummary } from '../../lib/research';
import ToolError from './ToolError.vue';

const emit = defineEmits<{ fetch: [url: string] }>();

const query = ref('');
const limit = ref(10);
const running = ref<string | null>(null); // request id while searching
const result = ref<ToolSearchResult | null>(null);
const lastQuery = ref('');
const health = ref<SearchHealth | null>(null);
const checking = ref(false);
const openError = ref<string | null>(null);

const canSearch = computed(() => query.value.trim().length > 0 && !running.value);
const healthView = computed(() => {
  const h = health.value;
  if (checking.value || !h) return { tone: 'neutral', text: 'Checking…', detail: '' };
  if (h.status === 'ready') {
    return {
      tone: 'ok',
      text: 'Ready',
      detail: `${h.provider} at ${h.endpoint} · ${formatMs(h.latencyMs)}`,
    };
  }
  if (h.status === 'not-configured')
    return { tone: 'warn', text: 'Not configured', detail: h.message };
  return { tone: 'error', text: 'Unavailable', detail: `${h.endpoint}: ${h.error.message}` };
});

async function checkHealth(): Promise<void> {
  checking.value = true;
  try {
    health.value = await window.api.researchTools.checkSearch();
  } catch (error) {
    health.value = {
      status: 'unavailable',
      endpoint: '—',
      error: { code: 'failed', message: error instanceof Error ? error.message : String(error) },
    };
  } finally {
    checking.value = false;
  }
}

async function search(): Promise<void> {
  if (!canSearch.value) return;
  const requestId = newRequestId();
  running.value = requestId;
  lastQuery.value = query.value.trim();
  openError.value = null;
  try {
    result.value = await window.api.researchTools.search({
      requestId,
      query: lastQuery.value,
      limit: limit.value,
    });
  } catch (error) {
    result.value = {
      status: 'error',
      durationMs: 0,
      error: { code: 'failed', message: error instanceof Error ? error.message : String(error) },
    };
  } finally {
    if (running.value === requestId) running.value = null;
  }
}

async function cancel(): Promise<void> {
  if (running.value) await window.api.researchTools.cancel(running.value);
}

async function open(url: string): Promise<void> {
  const outcome = await window.api.researchTools.openUrl(url);
  openError.value = outcome.status === 'refused' ? outcome.message : null;
}

onMounted(checkHealth);
</script>

<template>
  <section class="panel" data-testid="search-panel">
    <div
      class="card provider"
      data-testid="search-provider"
      :data-status="health?.status ?? 'checking'"
    >
      <span class="dot" :data-tone="healthView.tone" aria-hidden="true" />
      <div class="provider-text">
        <b>Search provider: {{ healthView.text }}</b>
        <span class="muted">{{ healthView.detail }}</span>
      </div>
      <button type="button" class="secondary" :disabled="checking" @click="checkHealth">
        Check again
      </button>
    </div>

    <form class="query card" @submit.prevent="search">
      <input
        v-model="query"
        type="search"
        maxlength="400"
        placeholder="Search the web, e.g. heat pump efficiency"
        aria-label="Search query"
        data-testid="search-query"
      />
      <select v-model.number="limit" aria-label="Number of results">
        <option :value="5">5 results</option>
        <option :value="10">10 results</option>
      </select>
      <button
        v-if="!running"
        type="submit"
        class="primary"
        data-testid="search-button"
        :disabled="!canSearch"
      >
        Search
      </button>
      <button v-else type="button" class="secondary" data-testid="search-cancel" @click="cancel">
        Cancel
      </button>
    </form>

    <div v-if="running" class="loading" role="status" data-testid="search-loading">
      <span class="spinner" aria-hidden="true" /> Searching for “{{ lastQuery }}”…
    </div>

    <template v-else-if="result">
      <ToolError
        v-if="result.status === 'error'"
        :error="result.error"
        :duration-ms="result.durationMs"
      />
      <template v-else>
        <p class="summary muted" data-testid="search-summary">
          {{ resultSummary(result.results.length, result.durationMs) }} for “{{ lastQuery }}” via
          {{ result.provider }}
        </p>
        <p v-if="openError" class="muted" role="alert">{{ openError }}</p>
        <div v-if="!result.results.length" class="card empty" data-testid="search-empty">
          <b>No results</b>
          <span class="muted">The search engines returned nothing usable for this query.</span>
        </div>
        <ol v-else class="results" data-testid="search-results">
          <li
            v-for="item in result.results"
            :key="item.url"
            class="card result"
            data-testid="search-result"
          >
            <span class="position" aria-label="Position">{{ item.position }}</span>
            <div class="result-body">
              <b class="result-title">{{ item.title }}</b>
              <span class="mono url">{{ item.url }}</span>
              <p v-if="item.snippet" class="snippet">{{ item.snippet }}</p>
              <span v-if="item.publishedAt" class="muted date">
                {{ item.publishedAt.slice(0, 10) }}
              </span>
            </div>
            <div class="result-actions">
              <button
                type="button"
                class="secondary"
                data-testid="open-result"
                @click="open(item.url)"
              >
                Open in browser
              </button>
              <button
                type="button"
                class="secondary"
                data-testid="fetch-result"
                @click="emit('fetch', item.url)"
              >
                Fetch &amp; extract
              </button>
            </div>
          </li>
        </ol>
      </template>
    </template>

    <p v-else class="hint muted">
      Runs the agent's <span class="mono">web_search</span> tool. Titles and snippets are untrusted
      text from the web.
    </p>
  </section>
</template>

<style scoped>
.panel {
  display: grid;
  gap: 12px;
  align-content: start;
}
.provider {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
}
.provider-text {
  display: grid;
  flex: 1;
  min-width: 0;
  font-size: 0.9rem;
}
.provider-text span {
  overflow-wrap: anywhere;
}
.dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--tone-fg);
  flex: none;
}
.query {
  display: flex;
  gap: 8px;
  padding: 10px;
}
.query input {
  flex: 1;
  min-width: 0;
}
.loading {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 24px;
  color: var(--muted);
}
.spinner {
  width: 14px;
  height: 14px;
  border: 2px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
.summary,
.hint {
  margin: 0;
  font-size: 0.88rem;
}
.empty {
  display: grid;
  gap: 4px;
  padding: 24px;
  text-align: center;
}
.results {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 8px;
}
.result {
  display: grid;
  grid-template-columns: 32px minmax(0, 1fr) auto;
  gap: 12px;
  padding: 12px 14px;
  align-items: start;
}
.position {
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: var(--selected);
  color: var(--accent);
  font-weight: 600;
  font-size: 0.85rem;
}
.result-body {
  display: grid;
  gap: 2px;
  min-width: 0;
}
.url {
  color: var(--ok);
  overflow-wrap: anywhere;
}
.snippet {
  margin: 4px 0 0;
  font-size: 0.9rem;
}
.date {
  font-size: 0.8rem;
}
.result-actions {
  display: grid;
  gap: 6px;
}
@media (max-width: 1000px) {
  .result {
    grid-template-columns: 32px minmax(0, 1fr);
  }
  .result-actions {
    grid-column: 2;
    display: flex;
  }
}
</style>
