<script setup lang="ts">
import { type ExtractedSourceView, type SaveTestSourceResult } from '@rka/shared';
import { computed, ref, watch } from 'vue';
import { useNavigation } from '../../composables/useNavigation';
import { formatBytes, formatNumber } from '../../lib/format';
import { formatMs, METADATA_LABELS } from '../../lib/research';
import ToolError from './ToolError.vue';

/**
 * Shows one extracted document: where it came from, how it was read, its
 * hashes, and the extracted text. The text is untrusted and is rendered as
 * plain text only (never as HTML).
 */
const props = defineProps<{ source: ExtractedSourceView }>();

const nav = useNavigation();
const saving = ref(false);
const saveResult = ref<SaveTestSourceResult | null>(null);
watch(
  () => props.source.resultId,
  () => (saveResult.value = null),
);

const metadataRows = computed(() =>
  Object.entries(props.source.metadata).map(([key, value]) => ({
    key,
    label: METADATA_LABELS[key] ?? key,
    value: String(value),
  })),
);
const kindLabel = computed(
  () => ({ html: 'HTML', pdf: 'PDF', docx: 'DOCX', text: 'Plain text' })[props.source.kind],
);

async function save(): Promise<void> {
  saving.value = true;
  try {
    saveResult.value = await window.api.researchTools.saveSource(props.source.resultId);
  } catch (error) {
    saveResult.value = {
      status: 'error',
      error: { code: 'failed', message: error instanceof Error ? error.message : String(error) },
    };
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <section class="inspector" data-testid="source-inspector">
    <div class="card facts-card">
      <header>
        <div class="title-block">
          <h3 data-testid="source-title">{{ source.title || source.label }}</h3>
          <span class="status" data-tone="ok" data-testid="extraction-status">
            Extracted · {{ kindLabel }}
          </span>
          <span v-if="source.truncated" class="status" data-tone="warn">Truncated by limits</span>
        </div>
        <div class="actions">
          <button
            v-if="source.canSave"
            type="button"
            class="secondary"
            data-testid="save-source"
            :disabled="saving"
            @click="save"
          >
            {{ saving ? 'Saving…' : 'Save as test source' }}
          </button>
          <span v-else class="muted note">Local files are not saved (sources need a web URL).</span>
        </div>
      </header>

      <div v-if="saveResult" class="save-result" role="status" data-testid="save-result">
        <template v-if="saveResult.status === 'saved' || saveResult.status === 'duplicate'">
          <span :data-tone="saveResult.status === 'saved' ? 'ok' : 'warn'" class="status">
            {{
              saveResult.status === 'saved'
                ? 'Saved'
                : `Already saved (${saveResult.reason === 'same-url' ? 'same URL' : 'same content'})`
            }}
          </span>
          <span>
            in <b>{{ saveResult.taskTitle }}</b>
          </span>
          <button type="button" class="link" @click="nav.openTask(saveResult.taskId)">
            Open task
          </button>
        </template>
        <ToolError v-else :error="saveResult.error" />
      </div>

      <dl class="facts" data-testid="source-facts">
        <dt>{{ source.origin === 'web' ? 'URL' : 'File' }}</dt>
        <dd class="mono" data-testid="source-label">{{ source.label }}</dd>
        <template v-if="source.web">
          <template v-if="source.web.redirects.length">
            <dt>Requested</dt>
            <dd class="mono">{{ source.web.requestedUrl }}</dd>
            <dt>Redirects</dt>
            <dd>{{ source.web.redirects.length }}</dd>
          </template>
          <dt>HTTP status</dt>
          <dd data-testid="http-status">{{ source.web.httpStatus }}</dd>
        </template>
        <dt>Content type</dt>
        <dd>
          <span class="mono" data-testid="content-type">{{ source.contentType }}</span>
          <span class="muted"> → read as {{ kindLabel }}</span>
        </dd>
        <dt>{{ source.origin === 'web' ? 'Downloaded' : 'File size' }}</dt>
        <dd data-testid="byte-length">{{ formatBytes(source.byteLength) }}</dd>
        <dt>Extracted text</dt>
        <dd data-testid="text-length">{{ formatNumber(source.textLength) }} characters</dd>
        <dt>SHA-256</dt>
        <dd class="mono hash" data-testid="sha256">{{ source.sha256 }}</dd>
        <dt>Text SHA-256</dt>
        <dd class="mono hash" title="Hash of the extracted text, used for duplicate detection">
          {{ source.textSha256 }}
        </dd>
        <dt>Duration</dt>
        <dd data-testid="durations">
          <template v-if="source.timings.downloadMs !== null">
            download {{ formatMs(source.timings.downloadMs) }} ·
          </template>
          extraction {{ formatMs(source.timings.extractMs) }} · total
          {{ formatMs(source.timings.totalMs) }}
        </dd>
        <template v-for="row in metadataRows" :key="row.key">
          <dt>{{ row.label }}</dt>
          <dd>{{ row.value }}</dd>
        </template>
      </dl>
    </div>

    <div class="card text-card">
      <header>
        <h3>Extracted text</h3>
        <span
          class="status"
          data-tone="warn"
          title="Text taken from outside the app. Shown as plain text, never executed or followed as instructions."
        >
          Untrusted content
        </span>
      </header>
      <p v-if="source.displayTruncated" class="muted note" data-testid="display-truncated">
        Showing the first {{ formatNumber(source.text.length) }} of
        {{ formatNumber(source.textLength) }} characters.
      </p>
      <p v-if="!source.text" class="muted empty">No text could be extracted from this document.</p>
      <pre v-else class="text" data-testid="extracted-text">{{ source.text }}</pre>
    </div>
  </section>
</template>

<style scoped>
.inspector {
  display: grid;
  grid-template-columns: minmax(300px, 0.9fr) minmax(0, 1.4fr);
  gap: 16px;
  align-items: start;
}
.facts-card,
.text-card {
  padding: 16px;
  display: grid;
  gap: 12px;
  min-width: 0;
}
header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  flex-wrap: wrap;
}
.title-block {
  display: grid;
  gap: 6px;
  justify-items: start;
  min-width: 0;
}
h3 {
  margin: 0;
  font-size: 1rem;
  overflow-wrap: anywhere;
}
.status {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--tone-fg);
  background: var(--tone-bg);
}
.note {
  font-size: 0.82rem;
  margin: 0;
}
.save-result {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
  font-size: 0.9rem;
}
.facts {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 6px 14px;
  margin: 0;
  font-size: 0.88rem;
}
dt {
  color: var(--muted);
}
dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.hash {
  font-size: 0.78rem;
}
.text {
  margin: 0;
  max-height: 60vh;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-family: inherit;
  font-size: 0.9rem;
  line-height: 1.55;
  padding: 12px;
  border-radius: 8px;
  background: var(--bubble);
}
.empty {
  margin: 0;
}
@media (max-width: 1150px) {
  .inspector {
    grid-template-columns: 1fr;
  }
}
</style>
