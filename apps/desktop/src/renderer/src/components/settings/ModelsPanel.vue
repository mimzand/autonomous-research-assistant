<script setup lang="ts">
import {
  matchesModelName,
  type EffectiveModelConfig,
  type ModelTestResult,
  type OllamaModelDetails,
  type OllamaModelList,
  type SettingKey,
} from '@rka/shared';
import { computed, onMounted, ref } from 'vue';
import { useModelHealth } from '../../composables/useModelHealth';
import { notify, useSettings } from '../../composables/useSettings';
import { formatDateTime } from '../../lib/format';
import { formatBytes } from '../../lib/settings';
import SettingsForm from './SettingsForm.vue';

/** Installed models from the configured server, the active model, and generation options. */
const list = ref<OllamaModelList | null>(null);
const loading = ref(false);
const details = ref<OllamaModelDetails | null>(null);
const effective = ref<EffectiveModelConfig | null>(null);
const prompt = ref('Reply with one short sentence: which model are you?');
const testResult = ref<ModelTestResult | null>(null);
const testing = ref<string | null>(null);
const health = useModelHealth();

const { view, save } = useSettings((changed) => {
  if (changed.some((k) => k.startsWith('model.') || k.startsWith('ollama.'))) {
    void loadEffective();
    if (changed.includes('ollama.baseUrl')) void refresh();
  }
});

const GENERATION: SettingKey[] = [
  'model.temperature',
  'model.topP',
  'model.topK',
  'model.numCtx',
  'model.numPredict',
  'model.repeatPenalty',
  'model.generateTimeoutMs',
];

async function refresh(): Promise<void> {
  loading.value = true;
  try {
    list.value = await window.api.ollama.listModels();
  } catch (error) {
    notify('error', error instanceof Error ? error.message : String(error));
  } finally {
    loading.value = false;
  }
}

async function loadEffective(): Promise<void> {
  effective.value = await window.api.ollama.effectiveConfig();
}

onMounted(async () => {
  await Promise.all([refresh(), loadEffective()]);
});

const active = computed(() => view.value?.values['model.name'] ?? '');
const names = computed(() =>
  list.value?.status === 'ok' ? list.value.models.map((m) => m.name) : [],
);

async function select(name: string): Promise<void> {
  const errors = await save({ 'model.name': name }, `Active model: ${name}.`);
  if (!Object.keys(errors).length) {
    await refresh();
    await health.refresh();
  }
}

async function showDetails(name: string): Promise<void> {
  details.value = await window.api.ollama.showModel(name);
  await loadEffective();
}

async function testModel(name: string): Promise<void> {
  testing.value = name;
  testResult.value = null;
  try {
    testResult.value = await window.api.ollama.testModel(name, prompt.value);
  } finally {
    testing.value = null;
  }
}

const isActive = (name: string) => matchesModelName(name, active.value);
</script>

<template>
  <div class="panel" data-testid="models-panel">
    <section class="card models">
      <div class="head">
        <h3>Installed models</h3>
        <span v-if="list?.status === 'ok'" class="muted small">
          {{ list.models.length }} on {{ list.url }} · {{ formatDateTime(list.fetchedAt) }}
        </span>
        <button type="button" data-testid="models-refresh" :disabled="loading" @click="refresh">
          {{ loading ? 'Loading…' : 'Refresh' }}
        </button>
      </div>
      <p class="current">
        Active model: <strong data-testid="active-model">{{ active }}</strong>
      </p>
      <div
        v-if="list?.status === 'ok' && !list.activeModelAvailable"
        class="notice"
        data-tone="warn"
        role="alert"
        data-testid="active-model-missing"
      >
        {{ active }} is not installed on {{ list.url }}. Choose one of the installed models below,
        or install it on that server with <code>ollama pull {{ active }}</code
        >. The app never downloads models by itself.
      </div>
      <div
        v-if="list?.status === 'error'"
        class="notice"
        data-tone="error"
        role="alert"
        data-testid="models-error"
      >
        Could not load the model list from {{ list.url }}: {{ list.error }}
      </div>
      <div
        v-else-if="list?.status === 'ok' && !list.models.length"
        class="empty"
        data-testid="models-empty"
      >
        No models are installed on this server. Install one there, e.g.
        <code>ollama pull qwen3:8b</code>, then click Refresh.
      </div>
      <div v-else-if="!list" class="empty">Loading models…</div>
      <div v-if="list?.status === 'ok' && list.models.length" class="table-wrap">
        <table data-testid="models-table">
          <thead>
            <tr>
              <th>Model</th>
              <th>Family</th>
              <th>Parameters</th>
              <th>Quantization</th>
              <th>Format</th>
              <th>Size</th>
              <th>Modified</th>
              <th><span class="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="m in list.models"
              :key="m.name"
              :data-active="isActive(m.name) || undefined"
              data-testid="model-row"
            >
              <td>
                <strong>{{ m.name }}</strong>
                <span v-if="isActive(m.name)" class="badge" data-tone="ok">Active</span>
              </td>
              <td>{{ m.family ?? '—' }}</td>
              <td>{{ m.parameterSize ?? '—' }}</td>
              <td>{{ m.quantization ?? '—' }}</td>
              <td>{{ m.format ?? '—' }}</td>
              <td>{{ formatBytes(m.sizeBytes) }}</td>
              <td>{{ m.modifiedAt ? formatDateTime(m.modifiedAt) : '—' }}</td>
              <td class="row-actions">
                <button
                  type="button"
                  class="primary"
                  :disabled="isActive(m.name)"
                  :data-testid="`use-${m.name}`"
                  @click="select(m.name)"
                >
                  Use
                </button>
                <button
                  type="button"
                  :data-testid="`details-${m.name}`"
                  @click="showDetails(m.name)"
                >
                  Details
                </button>
                <button
                  type="button"
                  :disabled="testing !== null"
                  :data-testid="`test-${m.name}`"
                  @click="testModel(m.name)"
                >
                  {{ testing === m.name ? 'Testing…' : 'Test' }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <label class="prompt">
        Test prompt
        <input v-model="prompt" maxlength="500" data-testid="test-prompt" />
      </label>
      <div v-if="testResult" class="result" data-testid="model-test-result">
        <template v-if="testResult.status === 'ok'">
          <p>
            <strong>{{ testResult.model }}</strong> answered in {{ testResult.durationMs }} ms ({{
              testResult.completionTokens ?? '?'
            }}
            tokens):
          </p>
          <blockquote>{{ testResult.reply }}{{ testResult.truncated ? ' …' : '' }}</blockquote>
          <p class="muted small">
            Options sent: <code>{{ JSON.stringify(testResult.options) }}</code>
          </p>
        </template>
        <p v-else class="error" role="alert">{{ testResult.model }}: {{ testResult.error }}</p>
      </div>
    </section>

    <section v-if="details" class="card details" data-testid="model-details">
      <div class="head">
        <h3>{{ details.name }}</h3>
        <button type="button" class="link" @click="details = null">Close</button>
      </div>
      <dl v-if="details.status === 'ok'">
        <dt>Capabilities</dt>
        <dd data-testid="model-capabilities">
          {{ details.capabilities.join(', ') || 'not reported' }}
        </dd>
        <dt>Architecture</dt>
        <dd>{{ details.architecture ?? '—' }}</dd>
        <dt>Family</dt>
        <dd>{{ details.family ?? '—' }}</dd>
        <dt>Parameters</dt>
        <dd>{{ details.parameterSize ?? '—' }}</dd>
        <dt>Quantization</dt>
        <dd>{{ details.quantization ?? '—' }}</dd>
        <dt>Format</dt>
        <dd>{{ details.format ?? '—' }}</dd>
        <dt>Context length</dt>
        <dd>{{ details.contextLength?.toLocaleString('en-US') ?? '—' }}</dd>
        <dt>Model defaults</dt>
        <dd>
          <pre>{{ details.parameters ?? '—' }}</pre>
        </dd>
        <dt>License</dt>
        <dd>{{ details.license ?? '—' }}</dd>
      </dl>
      <p v-else class="error">{{ details.error }}</p>
      <p
        v-if="
          details.status === 'ok' &&
          !details.capabilities.includes('tools') &&
          details.capabilities.length
        "
        class="muted small"
      >
        This model does not report tool support; the research agent still works (it uses JSON
        output), but tool-capable models such as qwen3 follow its instructions more reliably.
      </p>
    </section>

    <SettingsForm :keys="['model.name']" title="Active model" :models="names" testid="model-form">
      <template #intro>
        <p class="muted small">
          Used for chat and for research tasks started from now on. Running tasks keep the model
          they started with.
        </p>
      </template>
    </SettingsForm>

    <SettingsForm :keys="GENERATION" title="Generation options" testid="generation-form">
      <template #intro>
        <p class="muted small">
          Sent to Ollama with every request. Empty fields are not sent, so the model's own defaults
          apply. Research steps always use temperature 0 and their own output limits for reliable
          JSON.
        </p>
      </template>
    </SettingsForm>

    <section v-if="effective" class="card effective" data-testid="effective-config">
      <h3>Effective configuration</h3>
      <dl>
        <dt>Server</dt>
        <dd>{{ effective.url }}</dd>
        <dt>Model</dt>
        <dd>{{ effective.model }}</dd>
        <dt>Options sent</dt>
        <dd>
          <code data-testid="effective-options">{{ JSON.stringify(effective.options) }}</code>
        </dd>
        <dt>Request timeout</dt>
        <dd>
          {{ effective.generateTimeoutMs / 1000 }} s (streaming idle
          {{ effective.streamIdleTimeoutMs / 1000 }} s)
        </dd>
        <dt>Research overrides</dt>
        <dd>
          <code>{{ JSON.stringify(effective.researchOverrides) }}</code>
        </dd>
        <dt>Model defaults</dt>
        <dd>
          <pre v-if="effective.modelDefaults">{{ effective.modelDefaults }}</pre>
          <span v-else class="muted">Open "Details" of the active model to show them.</span>
        </dd>
      </dl>
    </section>
  </div>
</template>

<style scoped>
.panel {
  display: grid;
  gap: 16px;
  min-width: 0;
}
.panel > * {
  min-width: 0;
}
.models,
.details,
.effective {
  padding: 14px 16px;
}
.head {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.head h3 {
  margin: 0;
  font-size: 1rem;
  flex: 1;
}
h3 {
  margin: 0 0 8px;
  font-size: 1rem;
}
.current {
  margin: 8px 0;
}
.notice {
  padding: 8px 12px;
  border-radius: 8px;
  margin-bottom: 10px;
  color: var(--tone-fg);
  background: var(--tone-bg);
}
.empty {
  padding: 16px;
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
th,
td {
  text-align: left;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
}
th {
  color: var(--muted);
  font-weight: 600;
}
tr[data-active] {
  background: var(--selected);
}
.row-actions {
  display: flex;
  gap: 6px;
}
.row-actions button {
  padding: 2px 10px;
}
.badge {
  margin-left: 6px;
  font-size: 0.72rem;
  padding: 1px 8px;
  border-radius: 999px;
  color: var(--tone-fg);
  background: var(--tone-bg);
}
.prompt {
  display: grid;
  gap: 4px;
  margin-top: 12px;
  font-size: 0.9rem;
}
.prompt input {
  width: min(560px, 100%);
}
.result {
  margin-top: 10px;
}
blockquote {
  margin: 4px 0;
  padding: 8px 12px;
  border-left: 3px solid var(--border);
  background: var(--bubble);
  white-space: pre-wrap;
}
dl {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 4px 14px;
  margin: 0;
}
dt {
  color: var(--muted);
}
dd {
  margin: 0;
  min-width: 0;
  overflow-wrap: anywhere;
}
dd code {
  word-break: break-all;
}
pre {
  margin: 0;
  white-space: pre-wrap;
  font-size: 0.85rem;
}
.muted {
  color: var(--muted);
}
.small {
  font-size: 0.85rem;
}
.error {
  color: var(--error);
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
}
</style>
