import { computed, reactive } from 'vue';

export type Section = 'chat' | 'tasks' | 'knowledge' | 'reports' | 'storage';

export const SECTIONS: readonly { id: Section; label: string; description: string }[] = [
  { id: 'chat', label: 'Chat', description: 'Local model playground' },
  { id: 'tasks', label: 'Tasks', description: 'Tasks and execution history' },
  { id: 'knowledge', label: 'Knowledge Base', description: 'Sources and extracted content' },
  { id: 'reports', label: 'Reports', description: 'Generated research reports' },
  { id: 'storage', label: 'Storage', description: 'Database status and backups' },
];

const state = reactive({
  section: 'chat' as Section,
  /** Task open in the Tasks section (detail view), if any. */
  taskId: null as string | null,
});

/** App-wide navigation (one window, no URL routing needed). */
export function useNavigation() {
  return {
    section: computed(() => state.section),
    taskId: computed(() => state.taskId),
    go(section: Section): void {
      state.section = section;
      if (section !== 'tasks') state.taskId = null;
    },
    openTask(id: string): void {
      state.section = 'tasks';
      state.taskId = id;
    },
    closeTask(): void {
      state.taskId = null;
    },
  };
}
