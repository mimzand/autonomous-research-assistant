<script setup lang="ts">
defineProps<{ message: string; title?: string }>();
defineEmits<{ retry: [] }>();
</script>

<template>
  <div class="error" role="alert" data-testid="error-banner">
    <div>
      <strong>{{ title ?? 'Could not load data' }}</strong>
      <p>{{ message }}</p>
    </div>
    <button type="button" class="secondary" @click="$emit('retry')">Try again</button>
  </div>
</template>

<style scoped>
.error {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  padding: 12px 14px;
  border: 1px solid var(--error);
  border-radius: 8px;
  background: var(--error-bg);
}
strong {
  color: var(--error);
}
p {
  margin: 2px 0 0;
  overflow-wrap: anywhere;
}
</style>
