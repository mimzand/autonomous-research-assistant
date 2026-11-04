<script setup lang="ts">
import { type AppInfo } from '@rka/shared';
import { onMounted, ref } from 'vue';
import ModelStatusPanel from './components/ModelStatusPanel.vue';

const appInfo = ref<AppInfo | null>(null);

onMounted(async () => {
  try {
    appInfo.value = await window.api.getAppInfo();
  } catch {
    appInfo.value = null; // Footer is informational only.
  }
});
</script>

<template>
  <main class="shell">
    <header>
      <h1>Autonomous Research &amp; Knowledge Assistant</h1>
      <p class="muted">Local-only research assistant powered by Ollama.</p>
    </header>

    <ModelStatusPanel />

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
.muted {
  color: var(--muted);
  margin: 0;
}
</style>
