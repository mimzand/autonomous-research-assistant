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
  min-width: 0;
  overflow: hidden;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 340px;
  grid-template-rows: minmax(0, 1fr);
  gap: 16px;
}
.chat-area {
  min-height: 0;
  min-width: 0;
  overflow: hidden;
}
.side {
  overflow-y: auto;
  min-height: 0;
  min-width: 0;
}
@media (max-width: 1100px) {
  .chat-page {
    grid-template-columns: minmax(0, 1fr);
    /* Side panel scrolls inside its own row; the page stays viewport-sized. */
    grid-template-rows: minmax(0, 1fr) minmax(0, min(280px, 40%));
  }
}
</style>
