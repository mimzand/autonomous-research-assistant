<script setup lang="ts">
import { computed } from 'vue';
import { formatNumber } from '../../lib/format';

const props = defineProps<{ total: number; limit: number; offset: number; noun?: string }>();
const emit = defineEmits<{ change: [offset: number] }>();

const from = computed(() => (props.total === 0 ? 0 : props.offset + 1));
const to = computed(() => Math.min(props.offset + props.limit, props.total));
</script>

<template>
  <div class="pager" data-testid="pager">
    <span class="muted">
      {{ formatNumber(from) }}–{{ formatNumber(to) }} of {{ formatNumber(total) }}
      {{ noun ?? 'items' }}
    </span>
    <div class="buttons">
      <button
        type="button"
        class="secondary"
        :disabled="offset === 0"
        @click="emit('change', Math.max(0, offset - limit))"
      >
        Previous
      </button>
      <button
        type="button"
        class="secondary"
        :disabled="to >= total"
        @click="emit('change', offset + limit)"
      >
        Next
      </button>
    </div>
  </div>
</template>

<style scoped>
.pager {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 10px 2px 0;
  font-size: 0.9rem;
}
.buttons {
  display: flex;
  gap: 8px;
}
.muted {
  color: var(--muted);
}
</style>
