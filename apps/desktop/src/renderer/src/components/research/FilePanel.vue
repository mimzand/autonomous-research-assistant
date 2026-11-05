<script setup lang="ts">
import { type ExtractionResult, type PickFileResult } from '@rka/shared';
import { computed, ref } from 'vue';
import { formatBytes } from '../../lib/format';
import { newRequestId } from '../../lib/research';
import SourceInspector from './SourceInspector.vue';
import ToolError from './ToolError.vue';

defineProps<{ maxFileBytes: number | null }>();

const picking = ref(false);
const picked = ref<PickFileResult | null>(null);
const running = ref<string | null>(null);
const result = ref<ExtractionResult | null>(null);

const file = computed(() => (picked.value?.status === 'selected' ? picked.value.file : null));

async function choose(): Promise<void> {
  picking.value = true;
  try {
    const choice = await window.api.researchTools.pickFile();
    if (choice.status !== 'cancelled') {
      picked.value = choice;
      result.value = null;
    }
  } finally {
    picking.value = false;
  }
}

async function extract(): Promise<void> {
  if (!file.value || running.value) return;
  const requestId = newRequestId();
  running.value = requestId;
  try {
    result.value = await window.api.researchTools.extractFile({
      requestId,
      token: file.value.token,
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
</script>

<template>
  <section class="panel" data-testid="file-panel">
    <div class="card picker">
      <button
        type="button"
        class="secondary"
        data-testid="choose-file"
        :disabled="picking || !!running"
        @click="choose"
      >
        {{ picking ? 'Choosing…' : 'Choose PDF or DOCX…' }}
      </button>

      <div v-if="picked && picked.status !== 'cancelled'" class="file" data-testid="selected-file">
        <span class="file-name">
          {{ picked.status === 'selected' ? picked.file.name : picked.name }}
        </span>
        <span class="muted" data-testid="selected-file-size">
          {{ formatBytes(picked.status === 'selected' ? picked.file.size : picked.size) }}
        </span>
        <span v-if="file?.kind" class="kind" data-tone="info">{{ file.kind.toUpperCase() }}</span>
      </div>
      <span v-else class="muted">No file selected.</span>

      <div class="actions">
        <button
          v-if="!running"
          type="button"
          class="primary"
          data-testid="extract-file"
          :disabled="!file"
          @click="extract"
        >
          Extract
        </button>
        <button v-else type="button" class="secondary" data-testid="extract-cancel" @click="cancel">
          Cancel
        </button>
      </div>
    </div>
    <p class="hint muted">
      The file is read into memory in the main process and never saved, uploaded or opened by
      another program. The page never sees its folder path.
      <template v-if="maxFileBytes">Limit: {{ formatBytes(maxFileBytes) }}.</template>
    </p>

    <ToolError v-if="picked?.status === 'rejected'" :error="picked.error" />

    <div v-if="running" class="loading" role="status" data-testid="file-loading">
      <span class="spinner" aria-hidden="true" /> Extracting {{ file?.name }}…
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
.picker {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  flex-wrap: wrap;
}
.file {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: 1;
}
.file-name {
  font-weight: 600;
  overflow-wrap: anywhere;
}
.kind {
  padding: 0 8px;
  border-radius: 999px;
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--tone-fg);
  background: var(--tone-bg);
}
.actions {
  margin-left: auto;
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
</style>
