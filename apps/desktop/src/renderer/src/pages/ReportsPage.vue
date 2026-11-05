<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import EmptyState from '../components/ui/EmptyState.vue';
import ErrorBanner from '../components/ui/ErrorBanner.vue';
import PageHeader from '../components/ui/PageHeader.vue';
import PagerBar from '../components/ui/PagerBar.vue';
import { useAsyncData } from '../composables/useAsyncData';
import { useNavigation } from '../composables/useNavigation';
import { formatDateTime, formatNumber, formatRelative, hostOf } from '../lib/format';
import { renderMarkdown } from '../lib/markdown';

const PAGE_SIZE = 50;
const nav = useNavigation();
const search = ref('');
const debouncedSearch = ref('');
const offset = ref(0);
const selectedId = ref<string | null>(null);
const view = ref<'rendered' | 'source'>('rendered');

let debounce: ReturnType<typeof setTimeout> | undefined;
watch(search, (value) => {
  clearTimeout(debounce);
  debounce = setTimeout(() => (debouncedSearch.value = value.trim()), 250);
});

const list = useAsyncData(() =>
  window.api.reports.list({
    search: debouncedSearch.value || undefined,
    limit: PAGE_SIZE,
    offset: offset.value,
  }),
);
watch(debouncedSearch, () => {
  offset.value = 0;
  void list.refresh();
});
watch(offset, () => void list.refresh());

const detail = useAsyncData(async () =>
  selectedId.value ? window.api.reports.get(selectedId.value) : null,
);
watch(selectedId, () => void detail.refresh());

// Safe: markdown-it with raw HTML disabled and http(s)-only links (see lib/markdown.ts).
const html = computed(() =>
  detail.data.value ? renderMarkdown(detail.data.value.report.content) : '',
);
const hasFilters = computed(() => debouncedSearch.value !== '');
</script>

<template>
  <section class="page" data-testid="reports-page">
    <PageHeader title="Reports" subtitle="Research reports generated from collected sources.">
      <template #actions>
        <button type="button" class="secondary" @click="list.refresh()">Refresh</button>
      </template>
    </PageHeader>

    <div class="split">
      <div class="card panel">
        <input
          v-model="search"
          type="search"
          placeholder="Search report or task title…"
          aria-label="Search reports"
          data-testid="report-search"
        />
        <ErrorBanner v-if="list.error.value" :message="list.error.value" @retry="list.refresh()" />
        <div v-else-if="!list.loaded.value" class="loading" role="status">Loading reports…</div>
        <EmptyState
          v-else-if="list.data.value?.total === 0 && !hasFilters"
          title="No reports yet"
          text="Reports written by research tasks are stored with every version and the sources they cite."
        >
          <template #icon>▤</template>
        </EmptyState>
        <EmptyState v-else-if="list.data.value?.total === 0" title="No matching reports" compact />
        <template v-else-if="list.data.value">
          <ul class="reports">
            <li v-for="report in list.data.value.items" :key="report.id">
              <button
                type="button"
                class="report-row"
                :aria-current="selectedId === report.id"
                data-testid="report-row"
                @click="selectedId = report.id"
              >
                <span class="report-title">{{ report.title }}</span>
                <span class="report-meta">
                  <span>{{ report.taskTitle }}</span>
                  <span>v{{ report.version }}</span>
                  <span
                    >{{ report.citedCount }} cited source{{
                      report.citedCount === 1 ? '' : 's'
                    }}</span
                  >
                  <span :title="formatDateTime(report.createdAt)">{{
                    formatRelative(report.createdAt)
                  }}</span>
                </span>
              </button>
            </li>
          </ul>
          <PagerBar
            :total="list.data.value.total"
            :limit="PAGE_SIZE"
            :offset="offset"
            noun="reports"
            @change="offset = $event"
          />
        </template>
      </div>

      <article class="card reader" aria-label="Report" data-testid="report-reader">
        <EmptyState v-if="!selectedId" title="Select a report to read it" compact />
        <ErrorBanner
          v-else-if="detail.error.value"
          :message="detail.error.value"
          @retry="detail.refresh()"
        />
        <div v-else-if="detail.loading.value && !detail.data.value" class="loading">Loading…</div>
        <template v-else-if="detail.data.value">
          <header class="reader-head">
            <div>
              <h3>{{ detail.data.value.report.title }}</h3>
              <p class="muted">
                Version {{ detail.data.value.report.version }} ·
                {{ formatDateTime(detail.data.value.report.createdAt) }} ·
                {{ formatNumber(detail.data.value.report.contentLength) }} characters ·
                <button
                  type="button"
                  class="link"
                  @click="nav.openTask(detail.data.value.report.taskId)"
                >
                  {{ detail.data.value.report.taskTitle }}
                </button>
              </p>
            </div>
            <div class="segmented" role="radiogroup" aria-label="View">
              <button
                type="button"
                role="radio"
                :aria-checked="view === 'rendered'"
                @click="view = 'rendered'"
              >
                Formatted
              </button>
              <button
                type="button"
                role="radio"
                :aria-checked="view === 'source'"
                @click="view = 'source'"
              >
                Markdown
              </button>
            </div>
          </header>
          <!-- Safe: html comes from renderMarkdown (raw HTML escaped, http(s) links only). -->
          <!-- eslint-disable vue/no-v-html -->
          <div
            v-if="view === 'rendered'"
            class="markdown"
            data-testid="report-markdown"
            v-html="html"
          ></div>
          <!-- eslint-enable vue/no-v-html -->
          <pre v-else class="source">{{ detail.data.value.report.content }}</pre>

          <footer class="citations">
            <h4>Cited sources ({{ detail.data.value.citedSources.length }})</h4>
            <p v-if="detail.data.value.citedSources.length === 0" class="muted">
              This report cites no sources.
            </p>
            <ol v-else>
              <li v-for="source in detail.data.value.citedSources" :key="source.id">
                <a :href="source.url" target="_blank" rel="noopener noreferrer">{{
                  source.title || hostOf(source.url)
                }}</a>
                <span class="muted"> — {{ source.url }}</span>
              </li>
            </ol>
          </footer>
        </template>
      </article>
    </div>
  </section>
</template>

<style scoped>
.page {
  display: grid;
  gap: 16px;
  align-content: start;
}
.split {
  display: grid;
  grid-template-columns: minmax(280px, 0.8fr) minmax(0, 1.6fr);
  gap: 16px;
  align-items: start;
}
.panel {
  padding: 14px;
  display: grid;
  gap: 12px;
  min-width: 0;
}
.loading {
  padding: 32px;
  text-align: center;
  color: var(--muted);
}
.reports {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 2px;
}
.report-row {
  width: 100%;
  display: grid;
  gap: 2px;
  padding: 10px;
  border: none;
  border-radius: 6px;
  background: none;
  text-align: left;
}
.report-row[aria-current='true'] {
  background: var(--selected);
}
.report-title {
  font-weight: 600;
}
.report-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 10px;
  font-size: 0.82rem;
  color: var(--muted);
}
.reader {
  padding: 20px 24px;
  min-width: 0;
}
.reader-head {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: flex-start;
  border-bottom: 1px solid var(--border);
  padding-bottom: 12px;
  margin-bottom: 16px;
}
h3 {
  margin: 0;
  font-size: 1.2rem;
}
.reader-head p {
  margin: 4px 0 0;
  font-size: 0.85rem;
}
.segmented {
  display: flex;
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
  flex-shrink: 0;
}
.segmented button {
  border: none;
  border-radius: 0;
  font-size: 0.85rem;
}
.segmented button[aria-checked='true'] {
  background: var(--accent);
  color: var(--on-accent);
}
.markdown {
  line-height: 1.65;
  overflow-wrap: anywhere;
}
.markdown :deep(h1),
.markdown :deep(h2),
.markdown :deep(h3) {
  line-height: 1.3;
  margin: 1.2em 0 0.4em;
}
.markdown :deep(h1:first-child) {
  margin-top: 0;
}
.markdown :deep(pre) {
  padding: 12px;
  border-radius: 6px;
  background: var(--bg);
  overflow: auto;
}
.markdown :deep(code) {
  font-family: 'Cascadia Code', Consolas, monospace;
  font-size: 0.88em;
}
.markdown :deep(blockquote) {
  margin: 0;
  padding-left: 12px;
  border-left: 3px solid var(--border);
  color: var(--muted);
}
.markdown :deep(table) {
  border-collapse: collapse;
}
.markdown :deep(th),
.markdown :deep(td) {
  border: 1px solid var(--border);
  padding: 4px 8px;
}
.markdown :deep(a),
a {
  color: var(--accent);
}
.markdown :deep(.md-image-placeholder) {
  color: var(--muted);
  font-style: italic;
}
.source {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-family: 'Cascadia Code', Consolas, monospace;
  font-size: 0.85rem;
  margin: 0;
}
.citations {
  margin-top: 24px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}
h4 {
  margin: 0 0 8px;
  font-size: 0.95rem;
}
.citations ol {
  margin: 0;
  padding-left: 20px;
  display: grid;
  gap: 4px;
  font-size: 0.9rem;
  overflow-wrap: anywhere;
}
@media (max-width: 1100px) {
  .split {
    grid-template-columns: 1fr;
  }
}
</style>
