<script setup lang="ts">
import { type AppInfo, type ModelHealth } from '@rka/shared';
import { computed, onMounted, ref } from 'vue';

const appInfo = ref<AppInfo | null>(null);
const health = ref<ModelHealth | null>(null);
const checking = ref(false);
const bridgeError = ref<string | null>(null);

const statusLabel = computed(() => {
  switch (health.value?.status) {
    case 'ready':
      return 'Ready';
    case 'model-missing':
      return 'Model not installed';
    case 'unreachable':
      return 'Ollama unreachable';
    default:
      return 'Checking…';
  }
});

async function refreshHealth(): Promise<void> {
  checking.value = true;
  try {
    health.value = await window.api.getModelHealth();
    bridgeError.value = null;
  } catch (error) {
    bridgeError.value = error instanceof Error ? error.message : String(error);
  } finally {
    checking.value = false;
  }
}

onMounted(async () => {
  try {
    appInfo.value = await window.api.getAppInfo();
  } catch (error) {
    bridgeError.value = error instanceof Error ? error.message : String(error);
  }
  await refreshHealth();
});
</script>

<template>
  <main class="shell">
    <header>
      <h1>Autonomous Research &amp; Knowledge Assistant</h1>
      <p class="muted">Local-only research assistant powered by Ollama.</p>
    </header>

    <section class="card" aria-labelledby="model-heading">
      <div class="card-header">
        <h2 id="model-heading">Local model</h2>
        <button type="button" :disabled="checking" @click="refreshHealth">
          {{ checking ? 'Checking…' : 'Check again' }}
        </button>
      </div>

      <p class="status" :data-status="health?.status ?? 'pending'" role="status">
        {{ statusLabel }}
      </p>

      <dl v-if="health">
        <dt>Model</dt>
        <dd>{{ health.model }}</dd>
        <dt>Server</dt>
        <dd>{{ health.baseUrl }}</dd>
        <template v-if="health.status !== 'unreachable'">
          <dt>Ollama version</dt>
          <dd>{{ health.serverVersion }}</dd>
        </template>
      </dl>

      <p v-if="health?.status === 'model-missing'" class="hint">
        Install it with <code>ollama pull {{ health.model }}</code
        >. Installed: {{ health.installedModels.join(', ') || 'none' }}.
      </p>
      <p v-if="health?.status === 'unreachable'" class="hint">
        {{ health.error }}. Make sure Ollama is running.
      </p>
      <p v-if="bridgeError" class="hint error">{{ bridgeError }}</p>
    </section>

    <footer v-if="appInfo" class="muted">
      v{{ appInfo.version }} · Electron {{ appInfo.versions.electron }} · {{ appInfo.platform }}
    </footer>
  </main>
</template>

<style scoped>
.shell {
  max-width: 720px;
  margin: 0 auto;
  padding: 32px 16px;
  display: grid;
  gap: 24px;
}
h1 {
  font-size: 1.5rem;
  margin: 0 0 4px;
}
h2 {
  font-size: 1.1rem;
  margin: 0;
}
.muted {
  color: var(--muted);
  margin: 0;
}
.card {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 16px;
  background: var(--surface);
}
.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}
.status {
  font-weight: 600;
}
.status[data-status='ready'] {
  color: var(--ok);
}
.status[data-status='model-missing'],
.status[data-status='unreachable'] {
  color: var(--warn);
}
dl {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 4px 16px;
  margin: 0;
}
dt {
  color: var(--muted);
}
dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.hint {
  margin: 12px 0 0;
}
.error {
  color: var(--warn);
}
</style>
