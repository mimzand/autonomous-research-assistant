<script setup lang="ts">
import { describeReadiness, type ReadinessIssue } from '@rka/shared';
import { computed, onMounted, ref } from 'vue';
import { useModelHealth } from '../composables/useModelHealth';
import { useNavigation } from '../composables/useNavigation';
import { useSettings } from '../composables/useSettings';

/**
 * Startup checks shown above every page: Ollama reachable, the configured
 * model installed, web search configured. The app never downloads a model:
 * it shows the `ollama pull` command for the user to run.
 */
const { health, checking, refresh } = useModelHealth();
const nav = useNavigation();
const { view } = useSettings((changed) => {
  if (changed.includes('searxng.url')) void loadSearch();
});
const searchConfigured = ref<boolean | null>(null);
const dismissed = ref(new Set<string>());
const copied = ref<string | null>(null);

async function loadSearch(): Promise<void> {
  try {
    searchConfigured.value = (await window.api.researchTools.status()).search.configured;
  } catch {
    searchConfigured.value = null; // Unknown: do not warn.
  }
}
onMounted(loadSearch);

const issues = computed<ReadinessIssue[]>(() => {
  // Hidden while the Settings page is open (it shows the same information) or when turned off.
  if (!health.value || nav.section.value === 'settings') return [];
  if (view.value && !view.value.values['general.showStartupChecks']) return [];
  return describeReadiness(health.value, searchConfigured.value ?? true).filter(
    (issue) => !dismissed.value.has(issue.id),
  );
});

function dismiss(id: string): void {
  dismissed.value = new Set([...dismissed.value, id]);
}

async function copy(command: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(command);
    copied.value = command;
    setTimeout(() => (copied.value = null), 2000);
  } catch {
    copied.value = null; // Clipboard may be unavailable; the command is still selectable.
  }
}
</script>

<template>
  <section
    v-if="issues.length"
    class="startup-checks"
    aria-label="Startup checks"
    data-testid="startup-checks"
  >
    <div
      v-for="issue in issues"
      :key="issue.id"
      class="issue"
      :data-tone="issue.severity === 'error' ? 'error' : 'warn'"
      :data-testid="`startup-issue-${issue.id}`"
      role="alert"
    >
      <div class="text">
        <strong>{{ issue.title }}</strong>
        <p>{{ issue.detail }}</p>
        <p v-if="issue.command" class="command">
          <code data-testid="startup-command">{{ issue.command }}</code>
          <button type="button" class="secondary small" @click="copy(issue.command)">
            {{ copied === issue.command ? 'Copied' : 'Copy' }}
          </button>
        </p>
      </div>
      <div class="actions">
        <button
          v-if="issue.id !== 'search-not-configured'"
          type="button"
          class="secondary small"
          data-testid="startup-recheck"
          :disabled="checking"
          @click="refresh()"
        >
          {{ checking ? 'Checking…' : 'Check again' }}
        </button>
        <button
          type="button"
          class="secondary small"
          data-testid="startup-open-settings"
          @click="nav.go('settings')"
        >
          Open Settings
        </button>
        <button
          type="button"
          class="secondary small"
          :aria-label="`Dismiss: ${issue.title}`"
          @click="dismiss(issue.id)"
        >
          ✕
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.startup-checks {
  display: grid;
  gap: 8px;
  margin-bottom: 16px;
}
.issue {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  border-radius: 8px;
  border-left: 4px solid var(--tone-fg);
  background: var(--tone-bg);
}
.issue strong {
  color: var(--tone-fg);
}
.issue p {
  margin: 4px 0 0;
}
.command {
  display: flex;
  align-items: center;
  gap: 8px;
}
code {
  font-family: 'Cascadia Code', Consolas, monospace;
  padding: 2px 8px;
  border-radius: 4px;
  background: var(--surface);
  user-select: all;
}
.actions {
  display: flex;
  gap: 6px;
  align-items: flex-start;
}
.small {
  padding: 2px 10px;
  font-size: 0.85rem;
}
</style>
