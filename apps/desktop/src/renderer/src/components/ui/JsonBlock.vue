<script setup lang="ts">
import { computed, ref } from 'vue';
import { prettyJson } from '../../lib/format';

const props = withDefaults(defineProps<{ value: unknown; label?: string; limit?: number }>(), {
  label: undefined,
  limit: 20_000,
});

const expanded = ref(false);
const view = computed(() => prettyJson(props.value, expanded.value ? undefined : props.limit));
const empty = computed(() => props.value === null || props.value === undefined);
</script>

<template>
  <figure class="json" data-testid="json-block">
    <figcaption v-if="label">{{ label }}</figcaption>
    <p v-if="empty" class="none">No data</p>
    <pre v-else tabindex="0">{{ view.text }}</pre>
    <button v-if="view.truncated" type="button" class="link" @click="expanded = true">
      Show complete value
    </button>
  </figure>
</template>

<style scoped>
.json {
  margin: 0;
  min-width: 0;
}
figcaption {
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--muted);
  margin-bottom: 4px;
}
pre {
  margin: 0;
  padding: 10px 12px;
  max-height: 360px;
  overflow: auto;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--bg);
  font-family: 'Cascadia Code', Consolas, monospace;
  font-size: 0.82rem;
  line-height: 1.45;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.none {
  margin: 0;
  color: var(--muted);
  font-style: italic;
}
.link {
  margin-top: 6px;
}
</style>
