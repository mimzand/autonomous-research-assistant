<script setup lang="ts">
import { type ExtractionResult } from '@rka/shared';
import { computed, ref } from 'vue';
import { newRequestId } from '../../lib/research';
import SourceInspector from './SourceInspector.vue';
import ToolError from './ToolError.vue';

const url = ref('');
const running = ref<string | null>(null);
const result = ref<ExtractionResult | null>(null);
const lastUrl = ref('');

const canFetch = computed(() => url.value.trim().length > 0 && !running.value);

async function fetchUrl(): Promise<void> {
  if (!canFetch.value) return;
  const requestId = newRequestId();
  running.value = requestId;
  lastUrl.value = url.value.trim();
  try {
    result.value = await window.api.researchTools.fetchUrl({ requestId, url: lastUrl.value });
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

/** Called by the page when "Fetch & extract" is used on a search result. */
function start(target: string): void {
  url.value = target;
  void fetchUrl();
}
defineExpose({ start });
</script>

<template>
  <section class="panel" data-testid="fetch-panel">
    <!-- novalidate: every URL goes to the main-process validator, which explains the refusal. -->
    <form class="query card" novalidate @submit.prevent="fetchUrl">
      <input
        v-model="url"
        type="url"
        maxlength="2048"
        placeholder="https://example.org/article or a .pdf / .docx link"
        aria-label="URL"
        spellcheck="false"
        data-testid="fetch-url"
      />
      <button
        v-if="!running"
        type="submit"
        class="primary"
        data-testid="fetch-button"
        :disabled="!canFetch"
      >
        Fetch
      </button>
      <button v-else type="button" class="secondary" data-testid="fetch-cancel" @click="cancel">
        Cancel
      </button>
    </form>
    <p class="hint muted">
      Only public <span class="mono">http</span>/<span class="mono">https</span> addresses.
      Localhost, private networks, link-local and cloud metadata addresses are blocked, and every
      redirect and DNS answer is checked again. Nothing is saved unless you choose “Save as test
      source”.
    </p>

    <div v-if="running" class="loading" role="status" data-testid="fetch-loading">
      <span class="spinner" aria-hidden="true" /> Fetching {{ lastUrl }}…
    </div>
    <template v-else-if="result">
      <ToolError
        v-if="result.status === 'error'"
        :error="result.error"
        :duration-ms="result.durationMs"
      />
      <SourceInspector v-else :source="result.source" />
    </template>
  </section>
</template>

<style scoped>
.panel {
  display: grid;
  gap: 12px;
  align-content: start;
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
.hint {
  margin: 0;
  font-size: 0.85rem;
}
.loading {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 24px;
  color: var(--muted);
  overflow-wrap: anywhere;
}
.spinner {
  width: 14px;
  height: 14px;
  flex: none;
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
</style>
