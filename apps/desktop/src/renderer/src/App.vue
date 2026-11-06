<script setup lang="ts">
import { type AppInfo } from '@rka/shared';
import { onMounted, ref } from 'vue';
import AppSidebar from './components/AppSidebar.vue';
import StartupChecks from './components/StartupChecks.vue';
import { useNavigation } from './composables/useNavigation';
import ChatPage from './pages/ChatPage.vue';
import KnowledgePage from './pages/KnowledgePage.vue';
import ReportsPage from './pages/ReportsPage.vue';
import ResearchToolsPage from './pages/ResearchToolsPage.vue';
import SettingsPage from './pages/SettingsPage.vue';
import StoragePage from './pages/StoragePage.vue';
import TaskDetailPage from './pages/TaskDetailPage.vue';
import TasksPage from './pages/TasksPage.vue';

const appInfo = ref<AppInfo | null>(null);
const nav = useNavigation();

onMounted(async () => {
  try {
    // Start page from Settings (read once when the app opens).
    const settings = await window.api.settings.get();
    const start = settings.startedWith.startSection;
    if (nav.section.value === 'chat' && start !== 'chat') nav.go(start);
  } catch {
    // Settings unavailable: stay on the default page.
  }
  try {
    appInfo.value = await window.api.getAppInfo();
  } catch {
    appInfo.value = null; // Footer is informational only.
  }
});
</script>

<template>
  <div class="shell">
    <AppSidebar :app-info="appInfo" />
    <main class="content" :data-section="nav.section.value">
      <!-- Always present (possibly empty) so the chat grid keeps its rows. -->
      <div class="startup-slot"><StartupChecks /></div>
      <!-- Chat stays mounted so an ongoing conversation or stream survives navigation. -->
      <ChatPage v-show="nav.section.value === 'chat'" />
      <KeepAlive :max="8">
        <TaskDetailPage
          v-if="nav.section.value === 'tasks' && nav.taskId.value"
          :key="`task-${nav.taskId.value}`"
          :task-id="nav.taskId.value"
        />
        <TasksPage v-else-if="nav.section.value === 'tasks'" key="tasks" />
        <KnowledgePage v-else-if="nav.section.value === 'knowledge'" key="knowledge" />
        <ReportsPage v-else-if="nav.section.value === 'reports'" key="reports" />
        <StoragePage v-else-if="nav.section.value === 'storage'" key="storage" />
        <ResearchToolsPage
          v-else-if="nav.section.value === 'research-tools'"
          key="research-tools"
        />
        <SettingsPage v-else-if="nav.section.value === 'settings'" key="settings" />
      </KeepAlive>
    </main>
  </div>
</template>

<style scoped>
.shell {
  height: 100vh;
  display: grid;
  grid-template-columns: 232px minmax(0, 1fr);
}
.content {
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  padding: 20px 24px;
  box-sizing: border-box;
}
.content[data-section='chat'] {
  overflow: hidden;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
}
@media (max-width: 960px) {
  .shell {
    grid-template-columns: 64px minmax(0, 1fr);
  }
  .content[data-section='chat'] {
    overflow-y: auto;
  }
}
</style>
