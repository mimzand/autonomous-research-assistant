<script setup lang="ts">
import { type TaskDetails } from '@rka/shared';
import { computed, watch } from 'vue';
import { useAsyncData } from '../../composables/useAsyncData';
import { useNavigation } from '../../composables/useNavigation';
import { formatDateTime, hostOf } from '../../lib/format';
import { renderMarkdown } from '../../lib/markdown';

/**
 * Live view of an autonomous research task: goal, progress, current step,
 * discovered sources and the final report. All data comes from SQLite via
 * the preload API; `refreshKey` changes whenever a progress event arrives.
 */
const props = defineProps<{ details: TaskDetails; refreshKey: number }>();
const nav = useNavigation();

const task = computed(() => props.details.task);
const progress = computed(() => props.details.progress);
const running = computed(() => task.value.status === 'running');
const goal = computed(() => {
  const input = task.value.input;
  return input &&
    typeof input === 'object' &&
    !Array.isArray(input) &&
    typeof input['goal'] === 'string'
    ? input['goal']
    : '';
});
const percent = computed(() => {
  const p = progress.value;
  if (!p || !p.total) return 0;
  return Math.min(100, Math.round((p.completed / p.total) * 100));
});
const phase = computed(() => {
  const s = task.value.status;
  if (s === 'completed') return { tone: 'ok', text: 'Completed' };
  if (s === 'failed') return { tone: 'error', text: 'Failed' };
  if (s === 'cancelled') return { tone: 'neutral', text: 'Cancelled' };
  if (props.details.recovery.paused) return { tone: 'info', text: 'Paused' };
  if (s === 'interrupted') {
    const kind = props.details.recovery.interruption?.kind;
    const waiting: Record<string, string> = {
      'model-unavailable': 'Waiting for Ollama',
      'search-unavailable': 'Waiting for SearXNG',
      offline: 'Waiting for the internet connection',
    };
    return { tone: 'warn', text: (kind && waiting[kind]) ?? 'Interrupted' };
  }
  return { tone: 'info', text: 'Running' };
});

const sources = useAsyncData(() =>
  window.api.knowledge.list({ taskId: task.value.id, limit: 50, offset: 0 }),
);
const report = useAsyncData(async () => {
  const list = await window.api.reports.list({ taskId: task.value.id, limit: 1, offset: 0 });
  const latest = list.items[0];
  return latest ? window.api.reports.get(latest.id) : null;
});
watch(
  () => [props.refreshKey, task.value.status, task.value.updatedAt] as const,
  () => {
    void sources.refresh({ silent: true });
    void report.refresh({ silent: true });
  },
);

const reportHtml = computed(() =>
  report.data.value ? renderMarkdown(report.data.value.report.content) : '',
);
</script>

<template>
  <section class="research" data-testid="research-view">
    <div class="card overview">
      <div class="overview-head">
        <div class="goal">
          <span class="muted label">Research goal</span>
          <p data-testid="research-goal">{{ goal }}</p>
        </div>
        <span class="phase" :data-tone="phase.tone" data-testid="research-phase">{{
          phase.text
        }}</span>
      </div>

      <div v-if="progress" class="progress-block">
        <div class="progress-text">
          <span data-testid="research-step">
            <template v-if="running && progress.current">
              Step {{ progress.current.seq }}: {{ progress.current.name }}
            </template>
            <template v-else-if="task.status === 'completed'">All steps completed</template>
            <template v-else-if="progress.current">
              Next: step {{ progress.current.seq }} — {{ progress.current.name }}
            </template>
          </span>
          <span class="muted" data-testid="research-progress">
            {{ progress.completed }} of {{ progress.estimated ? 'about ' : ''
            }}{{ progress.total }} steps · {{ percent }}%
          </span>
        </div>
        <div
          class="bar"
          role="progressbar"
          :aria-valuenow="percent"
          aria-valuemin="0"
          aria-valuemax="100"
          :data-tone="phase.tone"
        >
          <span :style="{ width: `${percent}%` }" :class="{ live: running }" />
        </div>
      </div>
      <p v-if="task.error && !details.recovery.paused" class="error-text" role="alert">
        {{ task.error }}
      </p>
    </div>

    <div class="columns">
      <div class="card sources" data-testid="research-sources">
        <header>
          <h3>Discovered sources</h3>
          <span class="muted">{{ sources.data.value?.items.length ?? 0 }}</span>
        </header>
        <p
          v-if="!sources.data.value?.items.length"
          class="muted empty"
          data-testid="research-sources-empty"
        >
          {{
            running ? 'Sources appear here as they are read.' : 'No source was saved for this task.'
          }}
        </p>
        <ol v-else class="source-list">
          <li v-for="s in sources.data.value.items" :key="s.id" data-testid="research-source">
            <b>{{ s.title || hostOf(s.url) }}</b>
            <span class="mono url">{{ s.url }}</span>
            <span class="muted small">
              {{ s.hasContent ? 'Text extracted' : 'No text' }} ·
              {{ formatDateTime(s.retrievedAt ?? s.createdAt) }}
            </span>
          </li>
        </ol>
        <button
          v-if="sources.data.value?.items.length"
          type="button"
          class="link"
          @click="nav.go('knowledge')"
        >
          Open in Knowledge Base
        </button>
      </div>

      <div class="card report" data-testid="research-report">
        <header>
          <h3>Final report</h3>
          <span
            class="badge"
            data-tone="warn"
            title="Generated by a local model from untrusted web sources. Check the cited sources."
          >
            Model-generated
          </span>
        </header>
        <template v-if="report.data.value">
          <p class="muted small">
            Version {{ report.data.value.report.version }} ·
            {{ report.data.value.citedSources.length }} cited source(s) ·
            {{ formatDateTime(report.data.value.report.createdAt) }}
            · <button type="button" class="link" @click="nav.go('reports')">Open in Reports</button>
          </p>
          <!-- Markdown is rendered with raw HTML disabled and only http(s) links (lib/markdown). -->
          <!-- eslint-disable vue/no-v-html -->
          <article class="markdown" data-testid="research-report-content" v-html="reportHtml" />
          <!-- eslint-enable vue/no-v-html -->
        </template>
        <p v-else class="muted empty" data-testid="research-report-empty">
          {{
            task.status === 'completed'
              ? 'No report was saved.'
              : 'The report appears here when the research is finished.'
          }}
        </p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.research {
  display: grid;
  gap: 16px;
}
.overview {
  padding: 16px;
  display: grid;
  gap: 14px;
}
.overview-head {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: flex-start;
}
.goal p {
  margin: 2px 0 0;
  font-size: 1.02rem;
}
.label {
  font-size: 0.78rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.phase,
.badge {
  padding: 2px 10px;
  border-radius: 999px;
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--tone-fg);
  background: var(--tone-bg);
  white-space: nowrap;
}
.progress-block {
  display: grid;
  gap: 6px;
}
.progress-text {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  font-size: 0.9rem;
}
.bar {
  height: 8px;
  border-radius: 999px;
  background: var(--bubble);
  overflow: hidden;
}
.bar span {
  display: block;
  height: 100%;
  background: var(--tone-fg);
  border-radius: inherit;
  transition: width 0.4s ease;
}
.bar span.live {
  background-image: linear-gradient(
    90deg,
    transparent 0%,
    color-mix(in srgb, white 35%, transparent) 50%,
    transparent 100%
  );
  background-size: 200% 100%;
  background-color: var(--tone-fg);
  animation: shimmer 1.6s linear infinite;
}
@keyframes shimmer {
  to {
    background-position: -200% 0;
  }
}
.error-text {
  margin: 0;
  color: var(--error);
  overflow-wrap: anywhere;
}
.columns {
  display: grid;
  grid-template-columns: minmax(260px, 0.8fr) minmax(0, 1.6fr);
  gap: 16px;
  align-items: start;
}
.sources,
.report {
  padding: 16px;
  display: grid;
  gap: 10px;
  min-width: 0;
}
header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}
h3 {
  margin: 0;
  font-size: 1rem;
}
.empty {
  margin: 0;
}
.source-list {
  margin: 0;
  padding-left: 20px;
  display: grid;
  gap: 8px;
}
.source-list li {
  display: grid;
  gap: 1px;
  min-width: 0;
}
.url {
  overflow-wrap: anywhere;
  color: var(--ok);
}
.small {
  font-size: 0.8rem;
}
.report .small {
  margin: 0;
}
.markdown {
  overflow-wrap: anywhere;
  line-height: 1.6;
}
.markdown :deep(h1) {
  font-size: 1.3rem;
  margin: 0 0 8px;
}
.markdown :deep(h2) {
  font-size: 1.05rem;
  margin: 18px 0 6px;
}
.markdown :deep(blockquote) {
  margin: 0;
  padding: 6px 12px;
  border-left: 3px solid var(--border);
  color: var(--muted);
}
.markdown :deep(p) {
  margin: 6px 0;
}
@media (max-width: 1150px) {
  .columns {
    grid-template-columns: 1fr;
  }
}
</style>
