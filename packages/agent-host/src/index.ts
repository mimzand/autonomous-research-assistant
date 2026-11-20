export type {
  HostDialogPort,
  HostPorts,
  HostSecretsPort,
  HostShellPort,
  HostUiPort,
} from './ports.js';
export {
  createAgentHost,
  forwardResearchProgress,
  type AgentHost,
  type AgentHostDeps,
  type AgentHostPorts,
  type AgentHostSettings,
} from './agent-host.js';
export {
  ChatController,
  toChatError,
  type ChatControllerDeps,
  type ChatEventSink,
  type ChatUsage,
} from './chat-controller.js';
export {
  adkChatEngine,
  AGENT_ENGINE_ENV,
  AgentEngineSchema,
  createAppChatEngines,
  createChatEngineSelector,
  createChatWebSearch,
  DEFAULT_AGENT_ENGINE,
  legacyChatEngine,
  parseAgentEngine,
  type AgentEngine,
  type ChatEngine,
  type ChatEngineSelectorOptions,
  type ChatWebSearch,
} from './chat-engine.js';
export {
  DEFAULT_RESEARCH_ENGINE,
  parseResearchEngine,
  PINNED_ENGINE_KEY,
  pinnedEngine,
  RESEARCH_ENGINE_ENV,
  ResearchEngineSchema,
  researchTaskInfo,
  researchTaskModelsFor,
  type ResearchEngine,
  type ResearchTaskModelsOptions,
} from './research-engine.js';
export { taskModelsFor } from './task-models.js';
export { createDashboardService, type DashboardDeps, type DashboardService } from './dashboard.js';
export {
  createResearchToolsService,
  MAX_DISPLAY_CHARS,
  PLAYGROUND_TASK_KIND,
  type ResearchToolsDeps,
  type ResearchToolsService,
} from './research-tools.js';
// Settings (Runtime Configuration Manager): shared by the in-process app and the
// agent service. Electron-free; secrets are encrypted by the shell (safeStorage).
export {
  createRuntimeConfig,
  environmentDefaults,
  normalizeValue,
  SAVED_PREFIX,
  SECRET_PREFIX,
  secretValueProblem,
  storageSecretStore,
  type ConfigApplier,
  type ConfigChange,
  type RuntimeConfig,
  type RuntimeConfigDeps,
  type SecretStore,
  type UpdateOptions,
} from './config/runtime-config.js';
export {
  httpsPolicyError,
  OVERRIDE_ENV_VARS,
  resolveEnvOverrides,
  type EnvOverride,
} from './config/env-overrides.js';
export {
  createOllamaSettingsService,
  OLLAMA_KEYS,
  ollamaApplier,
  ollamaHint,
  RESEARCH_OVERRIDES,
  testSearxng,
  toOllamaConfig,
  toResearchDefaults,
  toWebConfig,
  WEB_KEYS,
  webApplier,
  type OllamaSettingsDeps,
  type OllamaSettingsService,
} from './config/services.js';
export {
  createSettingsService,
  type SettingsService,
  type SettingsServiceDeps,
} from './config/settings-service.js';
