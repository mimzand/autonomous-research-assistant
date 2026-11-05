<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import ResearchView from '../components/research/ResearchView.vue';
import TaskLogPanel from '../components/research/TaskLogPanel.vue';
import EmptyState from '../components/ui/EmptyState.vue';
import ErrorBanner from '../components/ui/ErrorBanner.vue';
import JsonBlock from '../components/ui/JsonBlock.vue';
import PageHeader from '../components/ui/PageHeader.vue';
import StatusBadge from '../components/ui/StatusBadge.vue';
import { useAsyncData } from '../composables/useAsyncData';
import { useNavigation } from '../composables/useNavigation';
import { formatDateTime, formatDuration, formatNumber } from '../lib/format';
import { describeInterruption, interruptionDetail } from '../lib/task-recovery';

const props = defineProps<{ taskId: string }>();
const nav = useNavigation();

const details = useAsyncData(() => window.api.tasks.get(props.taskId), {
  // Follow live progress while the task runs (progress events also trigger a refresh).
  pollMs: (): number | null => (details.data.value?.task.status === 'running' ? 1500 : null),
});

// Live progress pushed by the main process for this task.
const progressKey = ref(0);
let unsubscribe: (() => void) | null = null;
onMounted(() => {
  unsubscribe = window.api.tasks.onProgress((event) => {
    if (event.taskId !== props.taskId) return;
    progressKey.value++;
    void details.refresh({ silent: true });
    details.reschedule();
  });
});
onUnmounted(() => unsubscribe?.());

const isResearch = computed(() => {
  const input = details.data.value?.task.input;
  return (
    !!input && typeof input === 'object' && !Array.isArray(input) && input['kind'] === 'research'
  );
});

const expanded = ref(new Set<string>());
const acting = ref(false);
const actionError = ref<string | null>(null);

const task = computed(() => details.data.value?.task ?? null);
const recovery = computed(() => details.data.value?.recovery ?? null);
const steps = computed(() => details.data.value?.steps ?? []);
const interruption = computed(() => describeInterruption(recovery.value?.interruption ?? null));
const waitingDetail = computed(() => interruptionDetail(recovery.value?.interruption ?? null));
const tokens = computed(() =>
  (details.data.value?.usage ?? []).reduce(
    (sum, u) => ({
      prompt: sum.prompt + u.promptTokens,
      completion: sum.completion + u.completionTokens,
    }),
    { prompt: 0, completion: 0 },
  ),
);

function toggle(stepId: string): void {
  const next = new Set(expanded.value);
  if (next.has(stepId)) next.delete(stepId);
  else next.add(stepId);
  expanded.value = next;
}

async function act(action: 'resume' | 'cancel' | 'pause' | 'retry'): Promise<void> {
  acting.value = true;
  actionError.value = null;
  try {
    const result = await window.api.tasks[action](props.taskId);
    if (result.status === 'rejected') actionError.value = result.message;
    await details.refresh({ silent: true });
    details.reschedule();
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : String(error);
  } finally {
    acting.value = false;
  }
}
</script>

<template>
  <section class="page" data-testid="task-detail">
    <ErrorBanner
      v-if="details.error.value"
      :message="details.error.value"
      @retry="details.refresh()"
    />
    <div v-else-if="!details.loaded.value" class="loading" role="status">Loading task…</div>
    <EmptyState
      v-else-if="details.data.value === null"
      title="Task not found"
      text="It may have been deleted."
    >
      <button type="button" class="secondary" @click="nav.closeTask()">Back to tasks</button>
    </EmptyState>

    <template v-else-if="task && recovery">
      <PageHeader :title="task.title" :subtitle="`Task ${task.id}`">
        <template #before>
          <button
            type="button"
            class="secondary back"
            aria-label="Back to tasks"
            @click="nav.closeTask()"
          >
            ←
          </button>
        </template>
        <template #actions>
          <span
            v-if="recovery.paused"
            class="paused-badge"
            data-tone="info"
            data-testid="paused-badge"
          >
            Paused
          </span>
          <StatusBadge v-else :status="task.status" />
          <button
            v-if="recovery.pausable"
            type="button"
            class="secondary"
            data-testid="pause-task"
            :disabled="acting"
            @click="act('pause')"
          >
            Pause
          </button>
          <button
            v-if="recovery.resumable"
            type="button"
            class="primary"
            data-testid="resume-task"
            :disabled="acting"
            @click="act('resume')"
          >
            Resume
          </button>
          <button
            v-if="recovery.retryable"
            type="button"
            class="primary"
            data-testid="retry-task"
            :disabled="acting"
            title="Run the failed step(s) again. Completed steps are kept."
            @click="act('retry')"
          >
            Retry
          </button>
          <button
            v-if="recovery.cancellable"
            type="button"
            class="secondary"
            data-testid="cancel-task"
            :disabled="acting"
            @click="act('cancel')"
          >
            {{ task.status === 'running' ? 'Stop' : 'Cancel task' }}
          </button>
        </template>
      </PageHeader>

      <p v-if="actionError" class="notice" data-tone="error" role="alert">{{ actionError }}</p>

      <div
        v-if="task.status === 'interrupted'"
        class="card recovery"
        :data-tone="interruption.tone"
        :data-kind="recovery.interruption?.kind ?? 'other'"
        data-testid="recovery-panel"
      >
        <strong>{{ interruption.title }}</strong>
        <p>
          {{ interruption.text }}
          {{ recovery.completedSteps }} of {{ recovery.totalSteps }} steps were completed and are
          kept with their outputs.
        </p>
        <p v-if="waitingDetail" class="detail" data-testid="recovery-detail">{{ waitingDetail }}</p>
        <p>{{ interruption.action }}</p>
        <p v-if="recovery.resumable && recovery.nextStep">
          <b>Resume</b> continues at step {{ recovery.nextStep.seq }} ({{
            recovery.nextStep.name
          }}). Completed steps will not run again.
        </p>
        <p v-else-if="recovery.reason">{{ recovery.reason }}</p>
      </div>

      <div
        v-if="task.status === 'failed' && isResearch"
        class="card recovery"
        data-tone="error"
        data-testid="failed-panel"
      >
        <strong>Failed</strong>
        <p>
          {{ recovery.completedSteps }} of {{ recovery.totalSteps }} steps were completed and are
          kept with their outputs.
          <template v-if="recovery.retryable">
            <b>Retry</b> runs the failed step{{ recovery.failedSteps === 1 ? '' : 's' }} again;
            completed steps will not run again.
          </template>
          <template v-else>Nothing can run again; start a new research task instead.</template>
        </p>
      </div>
      <p
        v-else-if="isResearch && recovery.failedSteps > 0"
        class="notice"
        data-tone="warn"
        data-testid="failed-steps-notice"
      >
        {{ recovery.failedSteps }} step{{ recovery.failedSteps === 1 ? '' : 's' }} failed (usually a
        source that could not be read). The research continued without
        {{ recovery.failedSteps === 1 ? 'it' : 'them' }}; see the timeline and the execution log.
      </p>

      <ResearchView
        v-if="isResearch && details.data.value"
        :details="details.data.value"
        :refresh-key="progressKey"
      />

      <div class="grid">
        <div class="card facts">
          <h3>Details</h3>
          <dl>
            <dt>Created</dt>
            <dd>{{ formatDateTime(task.createdAt) }}</dd>
            <dt>Last updated</dt>
            <dd>{{ formatDateTime(task.updatedAt) }}</dd>
            <dt>Started</dt>
            <dd>{{ formatDateTime(task.startedAt) }}</dd>
            <dt>Finished</dt>
            <dd>{{ formatDateTime(task.finishedAt) }}</dd>
            <dt>Duration</dt>
            <dd>{{ formatDuration(task.startedAt, task.finishedAt) }}</dd>
            <dt>Steps</dt>
            <dd>{{ recovery.completedSteps }} / {{ recovery.totalSteps }} completed</dd>
            <dt>Sources</dt>
            <dd>{{ details.data.value?.sourceCount }}</dd>
            <dt>Reports</dt>
            <dd>{{ details.data.value?.reportCount }}</dd>
            <dt>Model tokens</dt>
            <dd>
              {{ formatNumber(tokens.prompt) }} in · {{ formatNumber(tokens.completion) }} out
              <span v-for="u in details.data.value?.usage" :key="u.model" class="muted">
                ({{ u.model }}, {{ u.calls }} call{{ u.calls === 1 ? '' : 's' }})
              </span>
            </dd>
          </dl>
        </div>

        <div class="card io">
          <JsonBlock :value="task.input" label="Original input" />
          <JsonBlock v-if="task.output !== null" :value="task.output" label="Final output" />
          <p v-else class="muted no-output">No final output yet.</p>
          <div v-if="task.error" class="task-error" role="alert" data-testid="task-error">
            <span class="label">Error</span>
            <p>{{ task.error }}</p>
          </div>
        </div>
      </div>

      <TaskLogPanel
        v-if="isResearch"
        :task-id="task.id"
        :task-status="task.status"
        :refresh-key="progressKey"
      />

      <div class="card timeline-card">
        <h3>Execution timeline</h3>
        <EmptyState
          v-if="steps.length === 0"
          title="No steps recorded"
          text="This task has not executed any steps."
          compact
        />
        <ol v-else class="timeline" data-testid="step-timeline">
          <li v-for="step in steps" :key="step.id" class="step" data-testid="step">
            <div class="marker" :data-status="step.status" aria-hidden="true">{{ step.seq }}</div>
            <div class="step-body">
              <button
                type="button"
                class="step-head"
                :aria-expanded="expanded.has(step.id)"
                :data-testid="`step-toggle-${step.seq}`"
                @click="toggle(step.id)"
              >
                <span class="step-title">
                  <span class="kind">{{ step.kind }}</span>
                  {{ step.name }}
                </span>
                <StatusBadge kind="step" :status="step.status" />
              </button>
              <div class="step-meta">
                <span>Started {{ formatDateTime(step.startedAt) }}</span>
                <span>Finished {{ formatDateTime(step.finishedAt) }}</span>
                <span>{{ formatDuration(step.startedAt, step.finishedAt) }}</span>
                <span>Attempt{{ step.attempts === 1 ? '' : 's' }}: {{ step.attempts }}</span>
              </div>
              <p v-if="step.error" class="step-error">{{ step.error }}</p>
              <div v-if="expanded.has(step.id)" class="step-io" data-testid="step-io">
                <JsonBlock :value="step.input" label="Input" />
                <JsonBlock :value="step.output" label="Output" />
              </div>
            </div>
          </li>
        </ol>
      </div>
    </template>
  </section>
</template>

<style scoped>
.paused-badge {
  padding: 2px 10px;
  border-radius: 999px;
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--tone-fg);
  background: var(--tone-bg);
}
.page {
  display: grid;
  gap: 16px;
  align-content: start;
}
.loading {
  padding: 48px;
  text-align: center;
  color: var(--muted);
}
.back {
  padding: 4px 10px;
  font-size: 1.1rem;
}
.notice {
  margin: 0;
  padding: 8px 12px;
  border-radius: 8px;
  color: var(--tone-fg);
  background: var(--tone-bg);
}
.recovery {
  padding: 12px 16px;
  border-left: 4px solid var(--tone-fg);
  background: var(--tone-bg);
}
.recovery strong {
  color: var(--tone-fg);
}
.recovery p {
  margin: 4px 0 0;
}
.recovery .detail {
  font-family: 'Cascadia Code', Consolas, monospace;
  font-size: 0.82rem;
  overflow-wrap: anywhere;
}
.grid {
  display: grid;
  grid-template-columns: minmax(280px, 360px) minmax(0, 1fr);
  gap: 16px;
}
h3 {
  margin: 0 0 10px;
  font-size: 1rem;
}
.facts,
.io,
.timeline-card {
  padding: 16px;
  min-width: 0;
}
.io {
  display: grid;
  gap: 14px;
  align-content: start;
}
dl {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 6px 14px;
  margin: 0;
  font-size: 0.9rem;
}
dt {
  color: var(--muted);
}
dd {
  margin: 0;
}
.no-output {
  margin: 0;
}
.task-error {
  padding: 10px 12px;
  border-radius: 6px;
  border: 1px solid var(--error);
  background: var(--error-bg);
}
.task-error .label {
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  color: var(--error);
}
.task-error p {
  margin: 2px 0 0;
  overflow-wrap: anywhere;
}
.timeline {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 0;
}
.step {
  display: grid;
  grid-template-columns: 32px minmax(0, 1fr);
  gap: 12px;
  position: relative;
  padding-bottom: 16px;
}
.step:not(:last-child)::before {
  content: '';
  position: absolute;
  left: 15px;
  top: 30px;
  bottom: 0;
  width: 2px;
  background: var(--border);
}
.marker {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  font-weight: 650;
  font-size: 0.85rem;
  border: 2px solid var(--border);
  background: var(--surface);
}
.marker[data-status='completed'] {
  border-color: var(--ok);
  color: var(--ok);
}
.marker[data-status='running'] {
  border-color: var(--info);
  color: var(--info);
}
.marker[data-status='failed'] {
  border-color: var(--error);
  color: var(--error);
}
.marker[data-status='skipped'] {
  border-style: dashed;
  color: var(--muted);
}
.marker[data-status='interrupted'] {
  border-color: var(--warn);
  color: var(--warn);
}
.step-head {
  width: 100%;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 4px 8px;
  margin-left: -8px;
  border: none;
  background: none;
  text-align: left;
}
.step-title {
  font-weight: 600;
}
.kind {
  font-family: 'Cascadia Code', Consolas, monospace;
  font-size: 0.75rem;
  font-weight: 500;
  padding: 1px 6px;
  margin-right: 6px;
  border-radius: 4px;
  background: var(--bubble);
  color: var(--muted);
}
.step-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 16px;
  font-size: 0.82rem;
  color: var(--muted);
}
.step-error {
  margin: 6px 0 0;
  color: var(--error);
  overflow-wrap: anywhere;
}
.step-io {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  margin-top: 10px;
}
@media (max-width: 1000px) {
  .grid,
  .step-io {
    grid-template-columns: 1fr;
  }
}
</style>
