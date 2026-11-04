<script setup lang="ts">
import { type ModelHealth } from '@rka/shared';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { describeModelStatus } from '../model-status';

/** Re-check periodically so the panel notices Ollama starting or stopping. */
const POLL_INTERVAL_MS = 30_000;

const health = ref<ModelHealth | null>(null);
const checking = ref(false);
const bridgeError = ref<string | null>(null);
let timer: ReturnType<typeof setInterval> | undefined;

const view = computed(() => describeModelStatus(health.value));

async function refresh(): Promise<void> {
  if (checking.value) return;
  checking.value = true;
  try {
    // Goes through the preload bridge to the main process. The renderer never calls Ollama.
    health.value = await window.api.getModelHealth();
    bridgeError.value = null;
  } catch (error) {
    bridgeError.value = error instanceof Error ? error.message : String(error);
  } finally {
    checking.value = false;
  }
}

onMounted(() => {
  void refresh();
  timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
});

onBeforeUnmount(() => clearInterval(timer));
</script>

<template>
  <section class="card" aria-labelledby="model-status-heading">
    <div class="card-header">
      <h2 id="model-status-heading">Local model</h2>
      <button type="button" :disabled="checking" @click="refresh">
        {{ checking ? 'Checking…' : 'Check again' }}
      </button>
    </div>

    <dl class="rows">
      <dt>Ollama</dt>
      <dd>
        <span class="badge" :data-tone="view.connection.tone" role="status">
          {{ view.connection.label }}
        </span>
        <span v-if="view.serverVersion" class="muted">v{{ view.serverVersion }}</span>
        <div v-if="view.connectionDetail" class="detail">{{ view.connectionDetail }}</div>
      </dd>

      <dt>Model</dt>
      <dd>
        <code>{{ view.model }}</code>
      </dd>

      <dt>Availability</dt>
      <dd>
        <span class="badge" :data-tone="view.availability.tone">
          {{ view.availability.label }}
        </span>
      </dd>

      <template v-if="view.capabilities.length">
        <dt>Capabilities</dt>
        <dd class="chips">
          <span v-for="capability in view.capabilities" :key="capability" class="chip">
            {{ capability }}
          </span>
        </dd>
      </template>

      <template v-if="view.contextLength">
        <dt>Max context</dt>
        <dd>{{ view.contextLength }}</dd>
      </template>

      <template v-if="view.structuredOutput">
        <dt>Structured output</dt>
        <dd>{{ view.structuredOutput }}</dd>
      </template>

      <template v-if="view.serverUrl">
        <dt>Server</dt>
        <dd>{{ view.serverUrl }}</dd>
      </template>
    </dl>

    <p v-if="view.hint" class="hint">{{ view.hint }}</p>
    <p v-if="bridgeError" class="hint error">{{ bridgeError }}</p>
    <p v-if="view.checkedAt" class="muted small">Last checked {{ view.checkedAt }}</p>
  </section>
</template>

<style scoped>
.card {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 16px;
  background: var(--surface);
  display: grid;
  gap: 12px;
}
.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}
h2 {
  font-size: 1.1rem;
  margin: 0;
}
.rows {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 8px 16px;
  margin: 0;
  align-items: baseline;
}
dt {
  color: var(--muted);
}
dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.badge {
  display: inline-block;
  font-weight: 600;
  margin-right: 8px;
}
.badge[data-tone='ok'] {
  color: var(--ok);
}
.badge[data-tone='warn'] {
  color: var(--warn);
}
.badge[data-tone='error'] {
  color: var(--error);
}
.badge[data-tone='pending'] {
  color: var(--muted);
}
.detail {
  color: var(--muted);
  font-size: 0.9rem;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.chip {
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 0 8px;
  font-size: 0.85rem;
}
.muted {
  color: var(--muted);
}
.small {
  font-size: 0.85rem;
  margin: 0;
}
.hint {
  margin: 0;
}
.error {
  color: var(--error);
}
</style>
