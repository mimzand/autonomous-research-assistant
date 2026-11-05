<script setup lang="ts">
import { computed, ref } from 'vue';

/** Starts an autonomous research task. Validation is repeated in the main process. */
const emit = defineEmits<{ started: [taskId: string]; close: [] }>();

const goal = ref('');
const maxQuestions = ref(3);
const maxSources = ref(6);
const starting = ref(false);
const error = ref<string | null>(null);

const trimmed = computed(() => goal.value.trim());
const tooShort = computed(() => trimmed.value.length > 0 && trimmed.value.length < 10);
const canStart = computed(() => trimmed.value.length >= 10 && !starting.value);

async function start(): Promise<void> {
  if (!canStart.value) return;
  starting.value = true;
  error.value = null;
  try {
    const result = await window.api.tasks.startResearch({
      goal: trimmed.value,
      maxQuestions: maxQuestions.value,
      maxSources: maxSources.value,
    });
    if (result.status === 'ok') emit('started', result.taskId);
    else error.value = result.message;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    starting.value = false;
  }
}
</script>

<template>
  <form class="card new-research" data-testid="new-research" @submit.prevent="start">
    <header>
      <h3>New research</h3>
      <button type="button" class="link" @click="emit('close')">Close</button>
    </header>
    <label class="goal">
      <span>What should be researched?</span>
      <textarea
        v-model="goal"
        rows="3"
        maxlength="2000"
        placeholder="e.g. How efficient are air source heat pumps in cold climates, and what do they cost to install in Germany?"
        data-testid="research-goal-input"
        @keydown.ctrl.enter.prevent="start"
      />
      <small v-if="tooShort" class="hint" data-tone="warn">Use at least 10 characters.</small>
    </label>
    <div class="options">
      <label>
        <span>Sub-questions</span>
        <select v-model.number="maxQuestions" data-testid="research-max-questions">
          <option v-for="n in 6" :key="n" :value="n">{{ n }}</option>
        </select>
      </label>
      <label>
        <span>Sources to read</span>
        <select v-model.number="maxSources" data-testid="research-max-sources">
          <option v-for="n in 12" :key="n" :value="n">{{ n }}</option>
        </select>
      </label>
      <p class="muted note">
        Runs on your local Ollama model. Web pages are searched via SearXNG and read through the
        SSRF-protected fetcher. Every step is saved, so the task can be paused and resumed.
      </p>
      <button type="submit" class="primary" data-testid="start-research" :disabled="!canStart">
        {{ starting ? 'Starting…' : 'Start research' }}
      </button>
    </div>
    <p v-if="error" class="error" role="alert" data-testid="start-research-error">{{ error }}</p>
  </form>
</template>

<style scoped>
.new-research {
  padding: 16px;
  display: grid;
  gap: 12px;
}
header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
h3 {
  margin: 0;
  font-size: 1rem;
}
label {
  display: grid;
  gap: 4px;
  font-size: 0.88rem;
}
textarea {
  font: inherit;
  padding: 8px 10px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
  resize: vertical;
}
.hint {
  color: var(--tone-fg);
}
.options {
  display: flex;
  gap: 12px;
  align-items: flex-end;
  flex-wrap: wrap;
}
.note {
  flex: 1;
  min-width: 260px;
  margin: 0;
  font-size: 0.82rem;
}
.error {
  margin: 0;
  color: var(--error);
}
</style>
