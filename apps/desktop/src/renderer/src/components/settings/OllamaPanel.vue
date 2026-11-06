<script setup lang="ts">
import {
  OLLAMA_URL_EXAMPLES,
  type ConnectionTestResult,
  type OllamaConnectionState,
  type SettingKey,
} from '@rka/shared';
import { computed, onMounted, ref } from 'vue';
import { useModelHealth } from '../../composables/useModelHealth';
import { notify, handleResult, useSettings } from '../../composables/useSettings';
import { formatDateTime } from '../../lib/format';
import SettingsForm from './SettingsForm.vue';

/** Ollama server URL, connection test, Connect/Disconnect and the access token. */
const { view } = useSettings(() => void loadState());
const health = useModelHealth();
const state = ref<OllamaConnectionState | null>(null);
const test = ref<ConnectionTestResult | null>(null);
const testing = ref(false);
const draftUrl = ref<string | null>(null);
const token = ref('');
const savingToken = ref(false);

const KEYS: SettingKey[] = ['ollama.baseUrl', 'ollama.requestTimeoutMs'];

async function loadState(): Promise<void> {
  try {
    state.value = await window.api.ollama.connectionState();
  } catch (error) {
    notify('error', error instanceof Error ? error.message : String(error));
  }
}
onMounted(async () => {
  await loadState();
  await runTest();
});

/** Tests the URL in the field (even unsaved); nothing is saved. */
async function runTest(): Promise<void> {
  testing.value = true;
  try {
    test.value = await window.api.ollama.testConnection(draftUrl.value ?? undefined);
  } catch (error) {
    notify('error', error instanceof Error ? error.message : String(error));
  } finally {
    testing.value = false;
  }
}

async function toggleConnection(): Promise<void> {
  state.value = state.value?.connected
    ? await window.api.ollama.disconnect()
    : await window.api.ollama.connect();
  notify('info', state.value.connected ? 'Connected to Ollama.' : 'Disconnected from Ollama.');
  await health.refresh();
  if (state.value.connected) await runTest();
}

async function saveToken(value: string | null): Promise<void> {
  savingToken.value = true;
  try {
    handleResult(
      await window.api.settings.setSecret('ollama.authToken', value),
      value ? 'Access token saved (encrypted).' : 'Access token removed.',
    );
    token.value = '';
    await loadState();
  } finally {
    savingToken.value = false;
  }
}

const status = computed(() => {
  if (state.value && !state.value.connected) return { tone: 'warn', text: 'Disconnected' };
  if (testing.value && !test.value) return { tone: 'neutral', text: 'Checking…' };
  if (!test.value) return { tone: 'neutral', text: 'Unknown' };
  return test.value.ok
    ? { tone: 'ok', text: 'Connected' }
    : { tone: 'error', text: 'Not reachable' };
});
const tokenSet = computed(() => view.value?.secrets['ollama.authToken']?.set ?? false);
const testedOther = computed(
  () => test.value && view.value && test.value.url !== view.value.values['ollama.baseUrl'],
);
</script>

<template>
  <div class="panel" data-testid="ollama-panel">
    <section class="card status" data-testid="ollama-status">
      <div class="row">
        <span class="dot" :data-tone="status.tone" aria-hidden="true"></span>
        <strong data-testid="ollama-status-text">{{ status.text }}</strong>
        <span class="muted">{{ state?.url ?? view?.values['ollama.baseUrl'] }}</span>
      </div>
      <dl v-if="test?.ok" class="facts">
        <dt>Server version</dt>
        <dd data-testid="ollama-version">{{ test.version }}</dd>
        <dt>Response time</dt>
        <dd data-testid="ollama-latency">{{ test.latencyMs }} ms</dd>
        <dt>Checked</dt>
        <dd>{{ formatDateTime(test.checkedAt) }}</dd>
      </dl>
      <div v-else-if="test && !test.ok" class="problem" role="alert" data-testid="ollama-error">
        <p>{{ test.error }}</p>
        <p v-if="test.hint" class="hint">{{ test.hint }}</p>
      </div>
      <p v-if="testedOther" class="muted small">Tested {{ test?.url }} (not saved yet).</p>
      <ul
        v-if="test?.warnings.length"
        class="warnings"
        data-tone="warn"
        data-testid="ollama-warnings"
      >
        <li v-for="w in test.warnings" :key="w">{{ w }}</li>
      </ul>
      <div class="actions">
        <button type="button" data-testid="ollama-test" :disabled="testing" @click="runTest">
          {{ testing ? 'Testing…' : 'Test connection' }}
        </button>
        <button
          type="button"
          :class="state?.connected ? 'secondary' : 'primary'"
          data-testid="ollama-connect-toggle"
          @click="toggleConnection"
        >
          {{ state?.connected ? 'Disconnect' : 'Connect' }}
        </button>
      </div>
      <p class="muted small">
        Disconnect stops all requests to Ollama until you click Connect; the app always starts
        connected. Running research tasks then wait as "Waiting for Ollama".
      </p>
    </section>

    <SettingsForm
      :keys="KEYS"
      title="Server"
      testid="ollama-form"
      @draft="(key, value) => key === 'ollama.baseUrl' && (draftUrl = String(value))"
    >
      <template #intro>
        <p class="muted small">
          Local: <code>{{ OLLAMA_URL_EXAMPLES.local }}</code> · Network:
          <code>{{ OLLAMA_URL_EXAMPLES.network }}</code> · Remote:
          <code>{{ OLLAMA_URL_EXAMPLES.remote }}</code
          >. "Test connection" tests the address in the field without saving it. Saving applies to
          new chats and tasks right away; running tasks keep their server.
        </p>
      </template>
    </SettingsForm>

    <section class="card token" data-testid="ollama-token">
      <h3>Access token (optional)</h3>
      <p class="muted small">
        For a remote Ollama behind an authenticating reverse proxy. Sent as
        <code>Authorization: Bearer …</code>, only over HTTPS (or to this computer). Stored
        encrypted with Windows DPAPI; it is never shown again.
      </p>
      <p>
        Status:
        <strong data-testid="token-status">{{ tokenSet ? 'Set' : 'Not set' }}</strong>
        <template v-if="tokenSet && state && !state.tokenSent">
          — not sent to the current URL (plain HTTP to another computer).
        </template>
      </p>
      <div class="row">
        <input
          v-model="token"
          type="password"
          autocomplete="off"
          placeholder="Paste a new token"
          aria-label="New access token"
          data-testid="token-input"
          :disabled="!view?.encryptionAvailable"
        />
        <button
          type="button"
          class="primary"
          :disabled="!token.trim() || savingToken"
          data-testid="token-save"
          @click="saveToken(token)"
        >
          Save token
        </button>
        <button type="button" :disabled="!tokenSet || savingToken" @click="saveToken(null)">
          Remove
        </button>
      </div>
      <p v-if="view && !view.encryptionAvailable" class="problem">
        OS encryption is not available, so tokens cannot be stored.
      </p>
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
.status,
.token {
  padding: 14px 16px;
}
.row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--tone-fg);
}
.facts {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 4px 14px;
  margin: 10px 0 0;
}
dt {
  color: var(--muted);
}
dd {
  margin: 0;
}
.problem {
  margin-top: 10px;
  color: var(--error);
}
.problem p {
  margin: 0;
}
.hint {
  color: var(--text);
  margin-top: 4px !important;
}
.warnings {
  margin: 10px 0 0;
  padding: 8px 12px 8px 28px;
  border-radius: 8px;
  color: var(--tone-fg);
  background: var(--tone-bg);
}
.actions {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}
h3 {
  margin: 0 0 6px;
  font-size: 1rem;
}
.muted {
  color: var(--muted);
}
.small {
  font-size: 0.85rem;
}
input[type='password'] {
  width: min(360px, 100%);
}
</style>
