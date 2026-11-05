<script setup lang="ts">
defineProps<{ title: string; subtitle?: string }>();
</script>

<template>
  <header class="page-header">
    <div class="titles">
      <slot name="before" />
      <div>
        <h2>{{ title }}</h2>
        <p v-if="subtitle" class="subtitle">{{ subtitle }}</p>
      </div>
    </div>
    <div v-if="$slots['actions']" class="actions"><slot name="actions" /></div>
  </header>
</template>

<style scoped>
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  flex-wrap: wrap;
}
.titles {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  min-width: 0;
}
h2 {
  margin: 0;
  font-size: 1.35rem;
  overflow-wrap: anywhere;
}
.subtitle {
  margin: 2px 0 0;
  color: var(--muted);
}
.actions {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
</style>
