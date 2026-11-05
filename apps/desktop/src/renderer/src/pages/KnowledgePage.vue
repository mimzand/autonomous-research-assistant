<script setup lang="ts">
import { type SourceSummary } from '@rka/shared';
import { computed, ref, watch } from 'vue';
import EmptyState from '../components/ui/EmptyState.vue';
import ErrorBanner from '../components/ui/ErrorBanner.vue';
import JsonBlock from '../components/ui/JsonBlock.vue';
import PageHeader from '../components/ui/PageHeader.vue';
import PagerBar from '../components/ui/PagerBar.vue';
import { useAsyncData } from '../composables/useAsyncData';
import { useNavigation } from '../composables/useNavigation';
import { formatBytes, formatDateTime, formatNumber, hostOf, shortHash } from '../lib/format';

const PAGE_SIZE = 100;
/** Render at most this much extracted text at once; the rest on request. */
const TEXT_PREVIEW_CHARS = 100_000;

const nav = useNavigation();
const search = ref('');
const debouncedSearch = ref('');
const content = ref<'all' | 'extracted' | 'missing'>('all');
const offset = ref(0);
const selectedId = ref<string | null>(null);
const showFullText = ref(false);

let debounce: ReturnType<typeof setTimeout> | undefined;
watch(search, (value) => {
  clearTimeout(debounce);
  debounce = setTimeout(() => (debouncedSearch.value = value.trim()), 250);
});

const list = useAsyncData(() =>
  window.api.knowledge.list({
    search: debouncedSearch.value || undefined,
    content: content.value,
    limit: PAGE_SIZE,
    offset: offset.value,
  }),
);
watch([debouncedSearch, content], () => {
  offset.value = 0;
  void list.refresh();
});
watch(offset, () => void list.refresh());

const detail = useAsyncData(async () =>
  selectedId.value ? window.api.knowledge.get(selectedId.value) : null,
);
watch(selectedId, () => {
  showFullText.value = false;
  void detail.refresh();
});

/** Sources grouped by task, keeping the server's order. */
const groups = computed(() => {
  const map = new Map<string, { taskId: string; taskTitle: string; sources: SourceSummary[] }>();
  for (const source of list.data.value?.items ?? []) {
    const group = map.get(source.taskId) ?? {
      taskId: source.taskId,
      taskTitle: source.taskTitle,
      sources: [],
    };
    group.sources.push(source);
    map.set(source.taskId, group);
  }
  return [...map.values()];
});

const totals = computed(() => list.data.value?.totals);
const text = computed(() => {
  const value = detail.data.value?.content?.text ?? '';
  return showFullText.value || value.length <= TEXT_PREVIEW_CHARS
    ? { value, truncated: false }
    : { value: value.slice(0, TEXT_PREVIEW_CHARS), truncated: true };
});
</script>

<template>
  <section class="page" data-testid="knowledge-page">
    <PageHeader
      title="Knowledge Base"
      subtitle="Sources collected by research tasks and the text extracted from them."
    >
      <template #actions>
        <button type="button" class="secondary" @click="list.refresh()">Refresh</button>
      </template>
    </PageHeader>

    <div class="stats">
      <div class="stat card">
        <span>Sources</span><b data-testid="kb-total">{{ formatNumber(totals?.sources ?? 0) }}</b>
      </div>
      <div class="stat card">
        <span>With extracted text</span><b>{{ formatNumber(totals?.withContent ?? 0) }}</b>
      </div>
      <div class="stat card">
        <span>Extracted text size</span><b>{{ formatBytes(totals?.contentBytes ?? 0) }}</b>
      </div>
      <div class="stat card">
        <span>Tasks with sources</span><b>{{ formatNumber(totals?.tasksWithSources ?? 0) }}</b>
      </div>
    </div>

    <div class="split">
      <div class="card panel list-panel">
        <div class="toolbar">
          <input
            v-model="search"
            type="search"
            placeholder="Search URL, title or task…"
            aria-label="Search sources"
            data-testid="kb-search"
          />
          <select
            v-model="content"
            aria-label="Filter by extraction status"
            data-testid="kb-content-filter"
          >
            <option value="all">All sources</option>
            <option value="extracted">Text extracted</option>
            <option value="missing">Not extracted</option>
          </select>
        </div>

        <ErrorBanner v-if="list.error.value" :message="list.error.value" @retry="list.refresh()" />
        <div v-else-if="!list.loaded.value" class="loading" role="status">Loading sources…</div>
        <EmptyState
          v-else-if="(totals?.sources ?? 0) === 0"
          title="No sources yet"
          text="When a research task collects web pages, each source and its extracted text is stored here. Nothing has been collected so far."
        >
          <template #icon>❏</template>
        </EmptyState>
        <EmptyState
          v-else-if="groups.length === 0"
          title="No matching sources"
          text="Try another search or filter."
          compact
        />
        <template v-else>
          <div class="groups">
            <section
              v-for="group in groups"
              :key="group.taskId"
              class="group"
              data-testid="kb-group"
            >
              <header class="group-head">
                <span class="group-title">{{ group.taskTitle }}</span>
                <button type="button" class="link" @click="nav.openTask(group.taskId)">
                  Open task
                </button>
              </header>
              <ul>
                <li v-for="source in group.sources" :key="source.id">
                  <button
                    type="button"
                    class="source-row"
                    :aria-current="selectedId === source.id"
                    data-testid="kb-source"
                    @click="selectedId = source.id"
                  >
                    <span class="source-main">
                      <span class="source-title">{{ source.title || hostOf(source.url) }}</span>
                      <span class="source-url">{{ source.url }}</span>
                    </span>
                    <span class="source-side">
                      <span class="pill" :data-tone="source.hasContent ? 'ok' : 'neutral'">
                        {{ source.hasContent ? 'Extracted' : 'Not extracted' }}
                      </span>
                      <span class="muted size">
                        {{ formatBytes(source.byteLength) }} ·
                        <span class="mono" :title="source.sha256 ?? 'No content hash'">{{
                          shortHash(source.sha256)
                        }}</span>
                      </span>
                      <span class="muted size">{{ formatDateTime(source.createdAt) }}</span>
                    </span>
                  </button>
                </li>
              </ul>
            </section>
          </div>
          <PagerBar
            v-if="list.data.value"
            :total="list.data.value.total"
            :limit="PAGE_SIZE"
            :offset="offset"
            noun="sources"
            @change="offset = $event"
          />
        </template>
      </div>

      <aside class="detail" aria-label="Source details">
        <EmptyState
          v-if="!selectedId"
          title="Select a source"
          text="Its metadata and the extracted text are shown here."
          compact
        />
        <ErrorBanner
          v-else-if="detail.error.value"
          :message="detail.error.value"
          @retry="detail.refresh()"
        />
        <div v-else-if="detail.loading.value && !detail.data.value" class="loading">Loading…</div>
        <template v-else-if="detail.data.value">
          <section class="card panel" data-testid="kb-metadata">
            <h3>Source metadata</h3>
            <dl>
              <dt>Title</dt>
              <dd>{{ detail.data.value.source.title ?? '—' }}</dd>
              <dt>URL</dt>
              <dd>
                <a :href="detail.data.value.source.url" target="_blank" rel="noopener noreferrer">
                  {{ detail.data.value.source.url }}
                </a>
              </dd>
              <dt>Task</dt>
              <dd>{{ detail.data.value.source.taskTitle }}</dd>
              <dt>Retrieved</dt>
              <dd>{{ formatDateTime(detail.data.value.source.retrievedAt) }}</dd>
              <dt>Created</dt>
              <dd>{{ formatDateTime(detail.data.value.source.createdAt) }}</dd>
              <dt>Extraction</dt>
              <dd>
                {{ detail.data.value.source.hasContent ? 'Text extracted' : 'Not extracted' }}
              </dd>
            </dl>
            <JsonBlock
              v-if="detail.data.value.source.metadata !== null"
              :value="detail.data.value.source.metadata"
              label="Additional metadata"
            />
          </section>

          <section class="card panel content" data-testid="kb-content">
            <div class="content-head">
              <h3>Extracted content</h3>
              <span
                class="pill"
                data-tone="warn"
                title="Text taken from the web. Treated as data, never as instructions."
              >
                Untrusted web content
              </span>
            </div>
            <template v-if="detail.data.value.content">
              <dl class="content-facts">
                <dt>Type</dt>
                <dd>{{ detail.data.value.content.contentType }}</dd>
                <dt>Size</dt>
                <dd>{{ formatBytes(detail.data.value.content.byteLength) }}</dd>
                <dt>SHA-256</dt>
                <dd class="mono hash" :title="detail.data.value.content.sha256">
                  {{ detail.data.value.content.sha256 }}
                </dd>
                <dt>Extracted</dt>
                <dd>{{ formatDateTime(detail.data.value.content.updatedAt) }}</dd>
              </dl>
              <pre class="text" tabindex="0" data-testid="kb-text">{{ text.value }}</pre>
              <button v-if="text.truncated" type="button" class="link" @click="showFullText = true">
                Show all {{ formatBytes(detail.data.value.content.byteLength) }}
              </button>
            </template>
            <EmptyState
              v-else
              title="No extracted text"
              text="This source was recorded but its text has not been extracted."
              compact
            />
          </section>
        </template>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.page {
  display: grid;
  gap: 16px;
  align-content: start;
}
.stats {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}
.stat {
  display: grid;
  padding: 12px 14px;
}
.stat span {
  color: var(--muted);
  font-size: 0.85rem;
}
.stat b {
  font-size: 1.4rem;
  font-variant-numeric: tabular-nums;
}
.split {
  display: grid;
  grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr);
  gap: 16px;
  align-items: start;
}
.panel {
  padding: 14px;
  display: grid;
  gap: 12px;
  min-width: 0;
}
.toolbar {
  display: flex;
  gap: 8px;
}
.toolbar input {
  flex: 1;
}
.loading {
  padding: 32px;
  text-align: center;
  color: var(--muted);
}
.groups {
  display: grid;
  gap: 14px;
}
.group-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 8px;
  padding-bottom: 4px;
  border-bottom: 1px solid var(--border);
}
.group-title {
  font-weight: 650;
}
ul {
  list-style: none;
  margin: 0;
  padding: 0;
}
.source-row {
  width: 100%;
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 8px;
  border: none;
  border-radius: 6px;
  background: none;
  text-align: left;
}
.source-row[aria-current='true'] {
  background: var(--selected);
}
.source-main {
  display: grid;
  min-width: 0;
}
.source-title {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.source-url {
  font-size: 0.82rem;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.source-side {
  display: grid;
  justify-items: end;
  gap: 2px;
  flex-shrink: 0;
}
.size {
  font-size: 0.8rem;
}
.pill {
  font-size: 0.75rem;
  font-weight: 600;
  padding: 1px 8px;
  border-radius: 999px;
  color: var(--tone-fg);
  background: var(--tone-bg);
  white-space: nowrap;
}
.detail {
  display: grid;
  gap: 16px;
  position: sticky;
  top: 0;
}
h3 {
  margin: 0;
  font-size: 1rem;
}
dl {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 6px 14px;
  margin: 0;
  font-size: 0.9rem;
}
dt {
  color: var(--muted);
}
dd {
  margin: 0;
  overflow-wrap: anywhere;
}
a {
  color: var(--accent);
}
.content {
  border-left: 3px solid var(--warn);
}
.content-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}
.hash {
  font-size: 0.78rem;
}
.text {
  margin: 0;
  max-height: 420px;
  overflow: auto;
  padding: 12px;
  border-radius: 6px;
  border: 1px dashed var(--border);
  background: var(--bg);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-family: inherit;
  font-size: 0.9rem;
  line-height: 1.55;
}
@media (max-width: 1100px) {
  .split {
    grid-template-columns: 1fr;
  }
  .detail {
    position: static;
  }
}
</style>
