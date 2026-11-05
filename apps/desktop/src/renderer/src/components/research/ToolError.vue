<script setup lang="ts">
import { type ResearchError } from '@rka/shared';
import { computed } from 'vue';
import { describeError, formatMs } from '../../lib/research';

const props = defineProps<{ error: ResearchError; durationMs?: number | null }>();
const info = computed(() => describeError(props.error));
</script>

<template>
  <div class="tool-error" role="alert" data-testid="tool-error" :data-code="error.code">
    <div class="head">
      <strong>{{ info.title }}</strong>
      <span class="code mono">{{ error.code }}</span>
      <span v-if="durationMs !== undefined && durationMs !== null" class="muted">
        · {{ formatMs(durationMs) }}
      </span>
    </div>
    <p class="message">{{ error.message }}</p>
    <p v-if="info.hint" class="muted hint">{{ info.hint }}</p>
  </div>
</template>

<style scoped>
.tool-error {
  padding: 12px 14px;
  border: 1px solid var(--error);
  border-radius: 8px;
  background: var(--error-bg);
  display: grid;
  gap: 4px;
}
.head {
  display: flex;
  gap: 8px;
  align-items: baseline;
  flex-wrap: wrap;
}
strong {
  color: var(--error);
}
.code {
  padding: 0 6px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--error) 12%, transparent);
}
p {
  margin: 0;
  overflow-wrap: anywhere;
}
.hint {
  font-size: 0.85rem;
}
</style>
