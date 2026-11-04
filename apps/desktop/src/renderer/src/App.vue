<script setup lang="ts">
import { type AppInfo } from '@rka/shared';
import { onMounted, ref } from 'vue';
import ChatPanel from './components/ChatPanel.vue';
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
  <div class="shell">
    <header class="top">
      <h1>Autonomous Research &amp; Knowledge Assistant</h1>
      <p class="muted">Local-only research assistant powered by Ollama.</p>
    </header>

    <main class="workspace">
      <ChatPanel class="chat-area" />
      <aside class="sidebar" aria-label="Local model status">
        <ModelStatusPanel />
        <footer v-if="appInfo" class="muted small">
          v{{ appInfo.version }} · Electron {{ appInfo.versions.electron }} ·
          {{ appInfo.platform }}
        </footer>
      </aside>
    </main>
  </div>
</template>

<style scoped>
.shell {
  height: 100vh;
  display: flex;
  flex-direction: column;
  padding: 20px 20px 16px;
  gap: 16px;
  box-sizing: border-box;
}
h1 {
  font-size: 1.35rem;
  margin: 0 0 2px;
}
.workspace {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 360px;
  gap: 16px;
}
.chat-area {
  min-height: 0;
}
.sidebar {
  display: flex;
  flex-direction: column;
  gap: 12px;
  overflow-y: auto;
  min-height: 0;
}
.muted {
  color: var(--muted);
  margin: 0;
}
.small {
  font-size: 0.85rem;
}

/* Narrow windows: stack the status panel under the chat. */
@media (max-width: 900px) {
  .shell {
    height: auto;
    min-height: 100vh;
  }
  .workspace {
    grid-template-columns: 1fr;
  }
  .chat-area {
    height: 70vh;
  }
}
</style>
