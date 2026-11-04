import { type ModelHealth } from '@rka/shared';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

/** Re-check periodically so the UI notices Ollama starting or stopping. */
const POLL_INTERVAL_MS = 30_000;

/*
 * One shared health state for the whole window, so the chat header and the
 * status panel never disagree or poll twice.
 */
const health = ref<ModelHealth | null>(null);
const checking = ref(false);
const bridgeError = ref<string | null>(null);
let subscribers = 0;
let timer: ReturnType<typeof setInterval> | undefined;

async function refresh(): Promise<void> {
  if (checking.value) return;
  checking.value = true;
  try {
    // Goes through the preload bridge to the main process. The renderer never calls Ollama.
    health.value = await window.api.getModelHealth();
    bridgeError.value = null;
  } catch (error) {
    bridgeError.value = error instanceof Error ? error.message : String(error);
  } finally {
    checking.value = false;
  }
}

export function useModelHealth() {
  onMounted(() => {
    subscribers++;
    if (subscribers === 1) {
      void refresh();
      timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    }
  });

  onBeforeUnmount(() => {
    subscribers--;
    if (subscribers === 0) clearInterval(timer);
  });

  // Read-only views: only `refresh` changes the state.
  return {
    health: computed(() => health.value),
    checking: computed(() => checking.value),
    bridgeError: computed(() => bridgeError.value),
    refresh,
  };
}
