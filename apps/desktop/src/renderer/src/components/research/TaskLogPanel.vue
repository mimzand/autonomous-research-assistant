<script setup lang="ts">
import { type TaskLogEntry } from '@rka/shared';
import { computed, onMounted, ref, shallowRef, watch } from 'vue';
import { formatDateTime } from '../../lib/format';

/**
 * Execution log of one task (append-only, stored in SQLite). Loads new
 * entries incrementally: only entries after the last seen seq are fetched.
 */
const props = defineProps<{ taskId: string; refreshKey: number; taskStatus: string }>();

type Level = TaskLogEntry['level'];
const LEVELS: readonly Level[] = ['debug', 'info', 'warn', 'error'];

const entries = shallowRef<TaskLogEntry[]>([]);
const lastSeq = ref(0);
const error = ref<string | null>(null);
const open = ref(false);
const shown = ref<Set<Level>>(new Set(['info', 'warn', 'error']));
let loading = false;

const visible = computed(() => entries.value.filter((e) => shown.value.has(e.level)));
const problems = computed(
  () => entries.value.filter((e) => e.level === 'warn' || e.level === 'error').length,
);

async function load(): Promise<void> {
  if (loading) return;
  loading = true;
  try {
    // Pages of up to 500 entries until nothing new is returned.
    for (;;) {
      const page = await window.api.tasks.logs(props.taskId, lastSeq.value);
      if (page.items.length === 0) break;
      entries.value = [...entries.value, ...page.items];
      lastSeq.value = page.lastSeq;
      if (page.items.length < 500) break;
    }
    error.value = null;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading = false;
  }
}

function toggleLevel(level: Level): void {
  const next = new Set(shown.value);
  if (next.has(level)) next.delete(level);
  else next.add(level);
  shown.value = next;
}

onMounted(load);
watch(() => [props.refreshKey, props.taskStatus], load);
watch(
  () => props.taskId,
  () => {
    entries.value = [];
    lastSeq.value = 0;
    void load();
  },
);
</script>

<template>
  <div class="card log-card" data-testid="task-log">
    <button
      type="button"
      class="head"
      :aria-expanded="open"
      data-testid="task-log-toggle"
      @click="open = !open"
    >
      <h3>Execution log</h3>
      <span class="muted">
        {{ entries.length }} entr{{ entries.length === 1 ? 'y' : 'ies' }}
        <span v-if="problems" class="problems">· {{ problems }} warning/error</span>
      </span>
    </button>
    <template v-if="open">
      <div class="filters" role="group" aria-label="Log levels">
        <label v-for="level in LEVELS" :key="level">
          <input
            type="checkbox"
            :checked="shown.has(level)"
            :data-testid="`log-level-${level}`"
            @change="toggleLevel(level)"
          />
          {{ level }}
        </label>
      </div>
      <p v-if="error" class="error" role="alert">Could not load the log: {{ error }}</p>
      <p v-else-if="visible.length === 0" class="muted">No entries.</p>
      <ol v-else class="entries">
        <li
          v-for="entry in visible"
          :key="entry.seq"
          :data-level="entry.level"
          data-testid="log-entry"
        >
          <span class="time">{{ formatDateTime(entry.createdAt) }}</span>
          <span class="level">{{ entry.level }}</span>
          <code class="event">{{ entry.event }}</code>
          <span v-if="entry.stepSeq !== null" class="step">step {{ entry.stepSeq }}</span>
          <span class="message">{{ entry.message }}</span>
        </li>
      </ol>
    </template>
  </div>
</template>

<style scoped>
.log-card {
  padding: 12px 16px;
}
.head {
  width: 100%;
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 12px;
  padding: 0;
  border: none;
  background: none;
  text-align: left;
}
h3 {
  margin: 0;
  font-size: 1rem;
}
.problems {
  color: var(--warn);
}
.filters {
  display: flex;
  gap: 14px;
  margin: 10px 0;
  font-size: 0.85rem;
}
.entries {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 360px;
  overflow: auto;
  font-size: 0.82rem;
  display: grid;
  gap: 2px;
}
.entries li {
  display: grid;
  grid-template-columns: max-content 48px max-content max-content minmax(0, 1fr);
  gap: 8px;
  padding: 3px 6px;
  border-radius: 4px;
}
.entries li[data-level='warn'] {
  background: var(--warn-bg, transparent);
}
.entries li[data-level='error'] {
  background: var(--error-bg);
}
.time,
.step {
  color: var(--muted);
}
.level {
  font-weight: 600;
  text-transform: uppercase;
  font-size: 0.72rem;
}
li[data-level='warn'] .level {
  color: var(--warn);
}
li[data-level='error'] .level {
  color: var(--error);
}
.event {
  font-family: 'Cascadia Code', Consolas, monospace;
}
.message {
  overflow-wrap: anywhere;
}
.error {
  color: var(--error);
}
</style>
