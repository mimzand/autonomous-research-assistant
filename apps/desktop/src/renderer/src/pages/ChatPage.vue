<script setup lang="ts">
import ChatPanel from '../components/ChatPanel.vue';
import ModelStatusPanel from '../components/ModelStatusPanel.vue';
</script>

<template>
  <div class="chat-page" data-testid="chat-page">
    <ChatPanel class="chat-area" />
    <aside class="side" aria-label="Local model status">
      <ModelStatusPanel />
    </aside>
  </div>
</template>

<style scoped>
.chat-page {
  height: 100%;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 340px;
  gap: 16px;
}
.chat-area {
  min-height: 0;
}
.side {
  overflow-y: auto;
  min-height: 0;
}
@media (max-width: 1100px) {
  .chat-page {
    grid-template-columns: 1fr;
    grid-template-rows: minmax(420px, 1fr) auto;
    height: auto;
  }
}
</style>
