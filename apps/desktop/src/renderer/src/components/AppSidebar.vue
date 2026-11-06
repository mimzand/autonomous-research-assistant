<script setup lang="ts">
import { type AppInfo } from '@rka/shared';
import { computed } from 'vue';
import { useAsyncData } from '../composables/useAsyncData';
import { useModelHealth } from '../composables/useModelHealth';
import { SECTIONS, useNavigation, type Section } from '../composables/useNavigation';

defineProps<{ appInfo: AppInfo | null }>();

const nav = useNavigation();
const { health } = useModelHealth();
const counts = useAsyncData(() => window.api.tasks.counts(), { pollMs: () => 5000 });

const ICONS: Record<Section, string> = {
  chat: 'M4 5h16v10H8l-4 4z',
  tasks: 'M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01',
  knowledge: 'M5 4h10l4 4v12H5zM15 4v4h4M8 12h8M8 16h6',
  reports: 'M6 3h12v18H6zM9 8h6M9 12h6M9 16h4',
  storage:
    'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zm0 0v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  'research-tools':
    'M14.7 6.3a4 4 0 0 0-5.4 5.4L4 17l3 3 5.3-5.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.1-.4-.4-2.1z',
  settings:
    'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zm8.5 3a8.5 8.5 0 0 0-.1-1.3l2-1.6-2-3.4-2.4 1a8 8 0 0 0-2.2-1.3L15.4 2h-4l-.4 2.4a8 8 0 0 0-2.2 1.3l-2.4-1-2 3.4 2 1.6a8.5 8.5 0 0 0 0 2.6l-2 1.6 2 3.4 2.4-1a8 8 0 0 0 2.2 1.3l.4 2.4h4l.4-2.4a8 8 0 0 0 2.2-1.3l2.4 1 2-3.4-2-1.6c.1-.4.1-.9.1-1.3z',
};

const badge = (section: Section): { text: string; tone: string } | null => {
  if (section !== 'tasks' || !counts.data.value) return null;
  const { running, interrupted } = counts.data.value.byStatus;
  if (running) return { text: String(running), tone: 'info' };
  if (interrupted) return { text: String(interrupted), tone: 'warn' };
  return null;
};

const modelLine = computed(() => {
  const h = health.value;
  if (!h) return { text: 'Checking model…', tone: 'neutral' };
  if (h.status === 'ready') return { text: h.model, tone: 'ok' };
  if (h.status === 'model-missing') return { text: `${h.model} not installed`, tone: 'warn' };
  if (h.reason === 'disconnected') return { text: 'Disconnected', tone: 'warn' };
  return { text: 'Ollama offline', tone: 'error' };
});
</script>

<template>
  <nav class="sidebar" aria-label="Main">
    <div class="brand">
      <span class="logo" aria-hidden="true">◆</span>
      <span class="name">Research Assistant</span>
    </div>
    <ul>
      <li v-for="section in SECTIONS" :key="section.id">
        <button
          type="button"
          class="item"
          :aria-current="nav.section.value === section.id ? 'page' : undefined"
          :title="section.description"
          :data-testid="`nav-${section.id}`"
          @click="nav.go(section.id)"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path :d="ICONS[section.id]" />
          </svg>
          <span class="label">{{ section.label }}</span>
          <span v-if="badge(section.id)" class="badge" :data-tone="badge(section.id)?.tone">
            {{ badge(section.id)?.text }}
          </span>
        </button>
      </li>
    </ul>
    <footer class="foot">
      <span class="model" :data-tone="modelLine.tone">
        <span class="dot" aria-hidden="true"></span>
        <span class="model-text">{{ modelLine.text }}</span>
      </span>
      <span v-if="appInfo" class="version"
        >v{{ appInfo.version }} · Electron {{ appInfo.versions.electron }}</span
      >
    </footer>
  </nav>
</template>

<style scoped>
.sidebar {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 16px 10px;
  background: var(--sidebar);
  border-right: 1px solid var(--border);
  min-height: 0;
}
.brand {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 10px 12px;
  font-weight: 650;
}
.logo {
  color: var(--accent);
}
ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 2px;
}
.item {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: none;
  border-radius: 8px;
  background: none;
  color: var(--text);
  text-align: left;
}
.item:hover {
  background: var(--hover);
}
.item[aria-current='page'] {
  background: var(--selected);
  color: var(--accent);
  font-weight: 600;
}
svg {
  width: 18px;
  height: 18px;
  flex-shrink: 0;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.label {
  flex: 1;
}
.badge {
  min-width: 20px;
  padding: 0 6px;
  border-radius: 999px;
  font-size: 0.75rem;
  font-weight: 700;
  text-align: center;
  color: var(--tone-fg);
  background: var(--tone-bg);
}
.foot {
  margin-top: auto;
  display: grid;
  gap: 4px;
  padding: 10px;
  font-size: 0.8rem;
}
.model {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text);
  min-width: 0;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--tone-fg);
  flex-shrink: 0;
}
.model-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.version {
  color: var(--muted);
}
@media (max-width: 960px) {
  .label,
  .name,
  .foot .version,
  .model-text {
    display: none;
  }
  .badge {
    position: absolute;
    margin: -18px 0 0 12px;
  }
}
</style>
