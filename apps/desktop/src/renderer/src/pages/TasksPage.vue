<script setup lang="ts">
import { type TaskStatus } from '@rka/shared';
import { computed, ref, watch } from 'vue';
import EmptyState from '../components/ui/EmptyState.vue';
import ErrorBanner from '../components/ui/ErrorBanner.vue';
import PageHeader from '../components/ui/PageHeader.vue';
import PagerBar from '../components/ui/PagerBar.vue';
import StatusBadge from '../components/ui/StatusBadge.vue';
import { useAsyncData } from '../composables/useAsyncData';
import { useNavigation } from '../composables/useNavigation';
import { formatCompactDateTime, formatDateTime, formatNumber, formatRelative } from '../lib/format';
import { TASK_FILTERS, TASK_STAT_CARDS, TASK_STATUS_META } from '../lib/status';

const PAGE_SIZE = 50;
const nav = useNavigation();

const filterIndex = ref(0);
const search = ref('');
const debouncedSearch = ref('');
const offset = ref(0);
const actionMessage = ref<{ tone: 'ok' | 'error'; text: string } | null>(null);
const starting = ref(false);

let debounce: ReturnType<typeof setTimeout> | undefined;
watch(search, (value) => {
  clearTimeout(debounce);
  debounce = setTimeout(() => (debouncedSearch.value = value.trim()), 250);
});

const statuses = computed<TaskStatus[]>(() => TASK_FILTERS[filterIndex.value]?.statuses ?? []);

/** Counts and the current page are loaded together, so they always agree. */
const list = useAsyncData(
  async () => {
    const [counts, page] = await Promise.all([
      window.api.tasks.counts(),
      window.api.tasks.list({
        status: statuses.value.length ? statuses.value : undefined,
        search: debouncedSearch.value || undefined,
        limit: PAGE_SIZE,
        offset: offset.value,
      }),
    ]);
    return { counts, ...page };
  },
  // Poll quickly while something runs, slowly otherwise.
  { pollMs: (): number => ((list.data.value?.counts.byStatus.running ?? 0) > 0 ? 1500 : 10_000) },
);
const counts = computed(() => list.data.value?.counts ?? null);

watch([statuses, debouncedSearch], () => {
  offset.value = 0;
  void list.refresh();
});
watch(offset, () => void list.refresh());

const hasFilters = computed(() => statuses.value.length > 0 || debouncedSearch.value !== '');
const statCards = computed(() =>
  TASK_STAT_CARDS.map((card) => ({
    ...card,
    value:
      card.key === 'total' ? (counts.value?.total ?? 0) : (counts.value?.byStatus[card.key] ?? 0),
    tone: card.key === 'total' ? 'neutral' : TASK_STATUS_META[card.key].tone,
    filter: TASK_FILTERS.findIndex((f) =>
      card.key === 'total'
        ? f.statuses.length === 0
        : f.statuses.length === 1 && f.statuses[0] === card.key,
    ),
  })),
);

function refreshAll(): void {
  void list.refresh();
}

async function runPersistenceCheck(): Promise<void> {
  starting.value = true;
  actionMessage.value = null;
  try {
    const result = await window.api.tasks.runPersistenceCheck();
    if (result.status === 'ok') {
      actionMessage.value = {
        tone: 'ok',
        text: 'Persistence check started. It is stored in SQLite as it runs.',
      };
      await list.refresh({ silent: true });
      list.reschedule();
    } else {
      actionMessage.value = { tone: 'error', text: result.message };
    }
  } catch (error) {
    actionMessage.value = {
      tone: 'error',
      text: error instanceof Error ? error.message : String(error),
    };
  } finally {
    starting.value = false;
  }
}

function clearFilters(): void {
  filterIndex.value = 0;
  search.value = '';
  debouncedSearch.value = '';
}
</script>

<template>
  <section class="page" aria-labelledby="tasks-title" data-testid="tasks-page">
    <PageHeader
      title="Tasks"
      subtitle="Every task and step is read live from the local SQLite database."
    >
      <template #actions>
        <button type="button" class="secondary" @click="refreshAll">Refresh</button>
        <button
          type="button"
          class="primary"
          data-testid="run-persistence-check"
          :disabled="starting"
          title="Creates a real task that checks the model, asks it a question and verifies the stored answer."
          @click="runPersistenceCheck"
        >
          {{ starting ? 'Starting…' : 'Run persistence check' }}
        </button>
      </template>
    </PageHeader>

    <p v-if="actionMessage" class="notice" :data-tone="actionMessage.tone" role="status">
      {{ actionMessage.text }}
    </p>

    <div class="stats" role="list" aria-label="Task counts">
      <button
        v-for="card in statCards"
        :key="card.key"
        type="button"
        role="listitem"
        class="stat card"
        :data-tone="card.tone"
        :data-active="filterIndex === card.filter"
        :data-testid="`stat-${card.key}`"
        @click="filterIndex = card.filter"
      >
        <span class="stat-label">{{ card.label }}</span>
        <span class="stat-value">{{ formatNumber(card.value) }}</span>
      </button>
    </div>

    <div class="card panel">
      <div class="toolbar">
        <div class="chips" role="radiogroup" aria-label="Filter by status">
          <button
            v-for="(filter, index) in TASK_FILTERS"
            :key="filter.label"
            type="button"
            role="radio"
            class="chip"
            :aria-checked="filterIndex === index"
            :data-testid="`filter-${filter.label.toLowerCase()}`"
            @click="filterIndex = index"
          >
            {{ filter.label }}
          </button>
        </div>
        <input
          v-model="search"
          type="search"
          class="search"
          placeholder="Search title or input…"
          aria-label="Search tasks"
          data-testid="task-search"
        />
      </div>

      <ErrorBanner v-if="list.error.value" :message="list.error.value" @retry="list.refresh()" />

      <div v-else-if="!list.loaded.value" class="loading" role="status">Loading tasks…</div>

      <EmptyState
        v-else-if="list.data.value && list.data.value.total === 0 && !hasFilters"
        title="No tasks yet"
        text="Research tasks will appear here with their full execution history. Run a persistence check to create a real task and verify that it survives a restart."
      >
        <template #icon>☰</template>
        <button type="button" class="primary" @click="runPersistenceCheck">
          Run persistence check
        </button>
      </EmptyState>

      <EmptyState
        v-else-if="list.data.value && list.data.value.total === 0"
        title="No matching tasks"
        text="Try another status or search term."
        compact
      >
        <button type="button" class="secondary" @click="clearFilters">Clear filters</button>
      </EmptyState>

      <template v-else-if="list.data.value">
        <div class="table-wrap">
          <table data-testid="task-table">
            <thead>
              <tr>
                <th scope="col">Task</th>
                <th scope="col">Status</th>
                <th scope="col">Created</th>
                <th scope="col">Updated</th>
                <th scope="col">Started</th>
                <th scope="col">Finished</th>
                <th scope="col" class="num">Steps</th>
                <th scope="col" class="num">Sources</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="task in list.data.value.items"
                :key="task.id"
                tabindex="0"
                data-testid="task-row"
                @click="nav.openTask(task.id)"
                @keydown.enter="nav.openTask(task.id)"
              >
                <td class="title-cell">
                  <span class="title">{{ task.title }}</span>
                  <span class="preview">{{ task.inputPreview }}</span>
                </td>
                <td><StatusBadge :status="task.status" /></td>
                <td :title="formatDateTime(task.createdAt)">
                  {{ formatRelative(task.createdAt) }}
                </td>
                <td :title="formatDateTime(task.updatedAt)">
                  {{ formatRelative(task.updatedAt) }}
                </td>
                <td :title="formatDateTime(task.startedAt)">
                  {{ formatCompactDateTime(task.startedAt) }}
                </td>
                <td :title="formatDateTime(task.finishedAt)">
                  {{ formatCompactDateTime(task.finishedAt) }}
                </td>
                <td class="num">
                  <span :title="`${task.completedStepCount} of ${task.stepCount} completed`">
                    {{ task.completedStepCount }}/{{ task.stepCount }}
                  </span>
                </td>
                <td class="num">{{ task.sourceCount }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <PagerBar
          :total="list.data.value.total"
          :limit="PAGE_SIZE"
          :offset="offset"
          noun="tasks"
          @change="offset = $event"
        />
      </template>
    </div>
  </section>
</template>

<style scoped>
.page {
  display: grid;
  gap: 16px;
  align-content: start;
}
.notice {
  margin: 0;
  padding: 8px 12px;
  border-radius: 8px;
  color: var(--tone-fg);
  background: var(--tone-bg);
}
.stats {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 12px;
}
.stat {
  display: grid;
  gap: 2px;
  padding: 12px 14px;
  text-align: left;
  border-left: 3px solid var(--tone-fg);
}
.stat[data-active='true'] {
  background: var(--selected);
}
.stat-label {
  color: var(--muted);
  font-size: 0.85rem;
}
.stat-value {
  font-size: 1.5rem;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
}
.panel {
  padding: 14px;
  display: grid;
  gap: 12px;
  min-width: 0;
}
.toolbar {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.chips {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.chip {
  border-radius: 999px;
  padding: 4px 12px;
  font-size: 0.85rem;
}
.chip[aria-checked='true'],
.chip[aria-checked='true']:hover:not(:disabled) {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--on-accent);
}
.search {
  min-width: 260px;
}
.loading {
  padding: 32px;
  text-align: center;
  color: var(--muted);
}
.table-wrap {
  overflow-x: auto;
}
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9rem;
}
th {
  text-align: left;
  font-weight: 600;
  color: var(--muted);
  font-size: 0.78rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 8px;
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
}
td {
  padding: 10px 8px;
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
  vertical-align: top;
}
tbody tr {
  cursor: pointer;
}
tbody tr:hover,
tbody tr:focus-visible {
  background: var(--hover);
}
.title-cell {
  white-space: normal;
  min-width: 200px;
  max-width: 360px;
}
.title {
  display: block;
  font-weight: 600;
}
.preview {
  display: block;
  color: var(--muted);
  font-size: 0.85rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
@media (max-width: 1100px) {
  .stats {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
</style>
