<script setup lang="ts">
import { nextTick, ref } from 'vue';
import ErrorBanner from '../components/ui/ErrorBanner.vue';
import PageHeader from '../components/ui/PageHeader.vue';
import FetchPanel from '../components/research/FetchPanel.vue';
import FilePanel from '../components/research/FilePanel.vue';
import SearchPanel from '../components/research/SearchPanel.vue';
import { useAsyncData } from '../composables/useAsyncData';
import { formatBytes } from '../lib/format';
import { formatMs } from '../lib/research';

type Tab = 'search' | 'fetch' | 'file';
const TABS: readonly { id: Tab; label: string; description: string }[] = [
  { id: 'search', label: 'Web Search', description: 'web_search via SearXNG' },
  { id: 'fetch', label: 'Web Fetch & Extraction', description: 'SSRF-safe fetcher' },
  { id: 'file', label: 'Local File Extraction', description: 'PDF and DOCX' },
];

const tab = ref<Tab>('search');
const status = useAsyncData(() => window.api.researchTools.status());
const fetchPanel = ref<InstanceType<typeof FetchPanel> | null>(null);

async function fetchFromSearch(url: string): Promise<void> {
  tab.value = 'fetch';
  await nextTick();
  fetchPanel.value?.start(url);
}
</script>

<template>
  <section class="page" data-testid="research-tools-page">
    <PageHeader
      title="Research Tools"
      subtitle="Run the agent's research tools by hand. Everything they return is untrusted content."
    />

    <ErrorBanner
      v-if="status.error.value"
      :message="status.error.value"
      @retry="status.refresh()"
    />

    <div class="tabs" role="tablist" aria-label="Research tools">
      <button
        v-for="t in TABS"
        :key="t.id"
        type="button"
        role="tab"
        class="tab"
        :aria-selected="tab === t.id"
        :data-testid="`tab-${t.id}`"
        @click="tab = t.id"
      >
        <span>{{ t.label }}</span>
        <small class="muted">{{ t.description }}</small>
      </button>
    </div>

    <!-- v-show keeps each tool's input and results while switching tabs. -->
    <SearchPanel v-show="tab === 'search'" role="tabpanel" @fetch="fetchFromSearch" />
    <FetchPanel v-show="tab === 'fetch'" ref="fetchPanel" role="tabpanel" />
    <FilePanel
      v-show="tab === 'file'"
      role="tabpanel"
      :max-file-bytes="status.data.value?.limits.maxFileBytes ?? null"
    />

    <p v-if="status.data.value" class="limits muted" data-testid="tool-limits">
      Limits: download {{ formatBytes(status.data.value.limits.maxDownloadBytes) }} · fetch timeout
      {{ formatMs(status.data.value.limits.fetchTimeoutMs) }} · search timeout
      {{ formatMs(status.data.value.limits.searchTimeoutMs) }} · files
      {{ status.data.value.fileTypes.map((t) => `.${t}`).join(', ') }} up to
      {{ formatBytes(status.data.value.limits.maxFileBytes) }}
    </p>
  </section>
</template>

<style scoped>
.page {
  display: grid;
  gap: 16px;
  align-content: start;
}
.tabs {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}
.tab {
  display: grid;
  gap: 2px;
  justify-items: start;
  text-align: left;
  padding: 10px 14px;
  border-radius: 10px;
}
.tab span {
  font-weight: 600;
}
.tab small {
  font-size: 0.78rem;
}
.tab[aria-selected='true'],
.tab[aria-selected='true']:hover:not(:disabled) {
  border-color: var(--accent);
  background: var(--selected);
  color: var(--accent);
}
.limits {
  margin: 0;
  font-size: 0.8rem;
}
</style>
