<script setup lang="ts">
import { type StepStatus, type TaskStatus } from '@rka/shared';
import { computed } from 'vue';
import { STEP_STATUS_META, TASK_STATUS_META } from '../../lib/status';

const props = defineProps<
  { kind?: 'task'; status: TaskStatus } | { kind: 'step'; status: StepStatus }
>();

const meta = computed(() =>
  props.kind === 'step' ? STEP_STATUS_META[props.status] : TASK_STATUS_META[props.status],
);
</script>

<template>
  <span class="badge" :data-tone="meta.tone" :title="meta.hint" data-testid="status-badge">
    <span class="dot" :data-pulse="status === 'running'" aria-hidden="true"></span>
    {{ meta.label }}
  </span>
</template>

<style scoped>
.badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 10px 2px 8px;
  border-radius: 999px;
  font-size: 0.8rem;
  font-weight: 600;
  white-space: nowrap;
  color: var(--tone-fg);
  background: var(--tone-bg);
}
.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
}
.dot[data-pulse='true'] {
  animation: pulse 1.4s ease-in-out infinite;
}
@keyframes pulse {
  50% {
    opacity: 0.35;
  }
}
@media (prefers-reduced-motion: reduce) {
  .dot[data-pulse='true'] {
    animation: none;
  }
}
</style>
