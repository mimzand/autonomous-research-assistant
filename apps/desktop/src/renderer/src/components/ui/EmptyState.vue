<script setup lang="ts">
defineProps<{ title: string; text?: string; compact?: boolean }>();
</script>

<template>
  <div class="empty" :data-compact="compact" data-testid="empty-state">
    <div class="icon" aria-hidden="true"><slot name="icon">◌</slot></div>
    <p class="title">{{ title }}</p>
    <p v-if="text" class="text">{{ text }}</p>
    <div v-if="$slots['default']" class="actions"><slot /></div>
  </div>
</template>

<style scoped>
.empty {
  display: grid;
  justify-items: center;
  text-align: center;
  gap: 6px;
  padding: 48px 24px;
  color: var(--muted);
}
.empty[data-compact='true'] {
  padding: 24px 16px;
}
.icon {
  font-size: 1.8rem;
  line-height: 1;
  opacity: 0.6;
}
.title {
  margin: 4px 0 0;
  font-weight: 600;
  color: var(--text);
}
.text {
  margin: 0;
  max-width: 46ch;
}
.actions {
  margin-top: 10px;
}
</style>
