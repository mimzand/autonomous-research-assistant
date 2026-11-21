<script setup lang="ts">
import { ollamaConnectionLabel } from '@rka/shared';
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { isSubmitKey } from '../chat/keyboard';
import { createChatSession } from '../chat/session';
import { toolStepLabel, toolStepStatusText } from '../chat/tool-steps';
import { useModelHealth } from '../composables/useModelHealth';

const { health, refresh: refreshHealth } = useModelHealth();
const modelName = computed(() => health.value?.model ?? 'qwen3:8b');
const modelReady = computed(() => health.value?.status === 'ready');
// From the effective server URL reported by the main process (updates after Settings → Save).
const connectionLabel = computed(() =>
  health.value ? ollamaConnectionLabel(health.value.baseUrl) : 'Ollama',
);

const chat = createChatSession(window.api.chat, {
  model: () => modelName.value,
  onConnectionProblem: () => void refreshHealth(),
});
const { messages, draft, phase, busy, canSend, loaded, startError } = chat;

const log = ref<HTMLElement | null>(null);
const input = ref<HTMLTextAreaElement | null>(null);
let stickToBottom = true;

function onScroll(): void {
  const el = log.value;
  if (el) stickToBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
}

// Follow the streaming reply unless the user scrolled up to read.
watch(
  () => [messages.value.length, messages.value.at(-1)?.content],
  async () => {
    await nextTick();
    if (stickToBottom && log.value) log.value.scrollTop = log.value.scrollHeight;
  },
);

function onKeydown(event: KeyboardEvent): void {
  if (!isSubmitKey(event)) return;
  event.preventDefault();
  void submit();
}

async function submit(): Promise<void> {
  if (!canSend.value) return;
  stickToBottom = true;
  await chat.send();
  input.value?.focus();
}

async function clearChat(): Promise<void> {
  await chat.clear();
  input.value?.focus();
}

const statusText = computed(() => {
  switch (phase.value) {
    case 'starting':
      return 'Waiting for the model…';
    case 'generating':
      return 'Generating…';
    case 'stopping':
      return 'Stopping…';
    default:
      return '';
  }
});

function formatStats(stats: { tokens: number | null; durationMs: number | null }): string {
  const parts: string[] = [];
  if (stats.tokens !== null) parts.push(`${stats.tokens} tokens`);
  if (stats.durationMs !== null) parts.push(`${(stats.durationMs / 1000).toFixed(1)} s`);
  return parts.join(' · ');
}

onBeforeUnmount(() => chat.dispose());
</script>

<template>
  <section class="chat" aria-labelledby="chat-heading">
    <header class="chat-header">
      <div>
        <h2 id="chat-heading">Chat playground</h2>
        <p class="model" data-testid="chat-model">
          <span class="dot" :data-ready="modelReady" aria-hidden="true"></span>
          <code>{{ modelName }}</code>
          <span class="muted" data-testid="chat-connection">· {{ connectionLabel }}</span>
        </p>
      </div>
      <button
        type="button"
        class="secondary"
        data-testid="chat-clear"
        :disabled="messages.length === 0"
        @click="clearChat"
      >
        Clear chat
      </button>
    </header>

    <div
      ref="log"
      class="log"
      role="log"
      aria-live="polite"
      aria-label="Conversation"
      data-testid="chat-log"
      @scroll="onScroll"
    >
      <p v-if="!loaded" class="empty" data-testid="chat-loading">Loading the conversation…</p>
      <p v-else-if="messages.length === 0" class="empty" data-testid="chat-empty">
        <template v-if="connectionLabel === 'Remote Ollama'">
          Send a message to test the model. Messages are sent to the Ollama server configured in
          Settings.
        </template>
        <template v-else>
          Send a message to test the local model. Everything stays on this computer.
        </template>
      </p>

      <article
        v-for="message in messages"
        :key="message.id"
        class="message"
        :data-role="message.role"
        :data-status="message.status"
        data-testid="chat-message"
      >
        <!-- Web searches the model made for this reply (Legacy Chat with web search). -->
        <ul v-if="message.tools.length" class="tools" data-testid="chat-tools">
          <li
            v-for="step in message.tools"
            :key="step.callId"
            class="tool"
            :data-status="step.status"
            data-testid="chat-tool"
          >
            <span class="tool-label">{{ toolStepLabel(step) }}</span>
            <span v-if="step.query" class="tool-query">“{{ step.query }}”</span>
            <span class="tool-status" data-testid="chat-tool-status">{{
              toolStepStatusText(step)
            }}</span>
          </li>
          <li
            v-if="message.tools.some((t) => t.status === 'completed')"
            class="tool-note muted"
            data-testid="chat-tool-note"
          >
            Search results are unverified web content; check important facts at the source.
          </li>
        </ul>
        <div class="bubble">
          <span class="sr-only">{{ message.role === 'user' ? 'You:' : 'Assistant:' }}</span>
          <!-- Plain text only (no HTML rendering of model output). -->
          <span class="text">{{ message.content }}</span>
          <span
            v-if="message.status === 'streaming' && !message.content"
            class="typing"
            aria-label="Model is responding"
          >
            <i></i><i></i><i></i>
          </span>
          <span v-else-if="message.status === 'streaming'" class="caret" aria-hidden="true"></span>
        </div>

        <p v-if="message.status === 'cancelled'" class="meta">
          {{ message.content ? 'Stopped' : 'Stopped before any output' }}
        </p>
        <p v-if="message.status === 'complete' && message.stats" class="meta">
          {{ formatStats(message.stats) }}
        </p>
        <div v-if="message.error" class="error" role="alert" data-testid="chat-error">
          <strong>{{ message.error.title }}</strong>
          <span v-if="message.error.hint">{{ message.error.hint }}</span>
          <small>{{ message.error.detail }}</small>
        </div>
      </article>
    </div>

    <div v-if="startError" class="error" role="alert" data-testid="chat-start-error">
      <strong>{{ startError.title }}</strong>
      <span v-if="startError.hint">{{ startError.hint }}</span>
      <small v-if="startError.detail">{{ startError.detail }}</small>
    </div>

    <form class="composer" @submit.prevent="submit">
      <label for="chat-input" class="sr-only">Message</label>
      <textarea
        id="chat-input"
        ref="input"
        v-model="draft"
        rows="3"
        placeholder="Message the local model… (Enter to send, Shift+Enter for a new line)"
        data-testid="chat-input"
        @keydown="onKeydown"
      ></textarea>
      <div class="actions">
        <span class="status" role="status" data-testid="chat-status">{{ statusText }}</span>
        <button
          v-if="busy"
          type="button"
          class="stop"
          data-testid="chat-stop"
          :disabled="phase === 'stopping'"
          @click="chat.stop"
        >
          Stop
        </button>
        <button v-else type="submit" data-testid="chat-send" :disabled="!canSend">Send</button>
      </div>
    </form>
  </section>
</template>

<style scoped>
.chat {
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  height: 100%;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
}
.chat-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border);
}
h2 {
  font-size: 1.1rem;
  margin: 0;
}
.model {
  margin: 2px 0 0;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.9rem;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--muted);
}
.dot[data-ready='true'] {
  background: var(--ok);
}
.log {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.empty {
  margin: auto;
  color: var(--muted);
  text-align: center;
  max-width: 36ch;
}
.message {
  display: flex;
  flex-direction: column;
  max-width: 85%;
  gap: 4px;
}
.tools {
  list-style: none;
  margin: 0 0 6px;
  padding: 6px 10px;
  display: grid;
  gap: 2px;
  font-size: 0.85rem;
  border-left: 3px solid var(--border, #ccc);
}
.tool {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: baseline;
  min-width: 0;
}
.tool-label {
  font-weight: 600;
}
.tool-query {
  overflow-wrap: anywhere;
  min-width: 0;
}
.tool-status {
  color: var(--muted);
}
.tool[data-status='failed'] .tool-status,
.tool[data-status='skipped'] .tool-status {
  color: var(--danger, var(--muted));
}
.tool-note {
  font-size: 0.8rem;
}
.message[data-role='user'] {
  align-self: flex-end;
  align-items: flex-end;
}
.message[data-role='assistant'] {
  align-self: flex-start;
}
.bubble {
  padding: 10px 14px;
  border-radius: 14px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  line-height: 1.5;
}
.message[data-role='user'] .bubble {
  background: var(--accent);
  color: var(--on-accent);
  border-bottom-right-radius: 4px;
}
.message[data-role='assistant'] .bubble {
  background: var(--bubble);
  border: 1px solid var(--border);
  border-bottom-left-radius: 4px;
}
.message[data-status='error'] .bubble:has(.text:empty) {
  display: none;
}
.meta {
  margin: 0;
  font-size: 0.8rem;
  color: var(--muted);
}
.caret {
  display: inline-block;
  width: 7px;
  height: 1em;
  margin-left: 2px;
  vertical-align: text-bottom;
  background: currentColor;
  animation: blink 1s steps(2, start) infinite;
}
.typing {
  display: inline-flex;
  gap: 4px;
}
.typing i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--muted);
  animation: pulse 1.2s infinite ease-in-out;
}
.typing i:nth-child(2) {
  animation-delay: 0.15s;
}
.typing i:nth-child(3) {
  animation-delay: 0.3s;
}
.error {
  display: grid;
  gap: 2px;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid var(--error);
  color: var(--text);
  background: var(--error-bg);
}
.error strong {
  color: var(--error);
}
.error small {
  color: var(--muted);
  overflow-wrap: anywhere;
}
.composer {
  border-top: 1px solid var(--border);
  padding: 12px 16px;
  display: grid;
  gap: 8px;
}
textarea {
  font: inherit;
  resize: vertical;
  min-height: 3.2em;
  max-height: 40vh;
  padding: 8px 10px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
}
textarea:focus-visible,
button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.actions {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 12px;
}
.status {
  margin-right: auto;
  color: var(--muted);
  font-size: 0.9rem;
}
button[type='submit'] {
  background: var(--accent);
  color: var(--on-accent);
  border-color: var(--accent);
  min-width: 84px;
}
.stop {
  border-color: var(--error);
  color: var(--error);
  min-width: 84px;
}
.muted {
  color: var(--muted);
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
@keyframes blink {
  to {
    visibility: hidden;
  }
}
@keyframes pulse {
  0%,
  80%,
  100% {
    opacity: 0.3;
  }
  40% {
    opacity: 1;
  }
}
@media (prefers-reduced-motion: reduce) {
  .caret,
  .typing i {
    animation: none;
  }
}
</style>
