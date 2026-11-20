import {
  ConnectionTestResultSchema,
  EffectiveModelConfigSchema,
  ModelNameRequestSchema,
  ModelTestRequestSchema,
  ModelTestResultSchema,
  OllamaConnectionStateSchema,
  OllamaModelDetailsSchema,
  OllamaModelListSchema,
  SecretUpdateRequestSchema,
  ServerUrlRequestSchema,
  SettingsPatchSchema,
  SettingsResetRequestSchema,
  SettingsUpdateResultSchema,
  SettingsValidateResultSchema,
  SettingsViewSchema,
  type ConnectionTestResult,
  type EffectiveModelConfig,
  type ModelTestResult,
  type OllamaConnectionState,
  type OllamaModelDetails,
  type OllamaModelList,
  type SettingsUpdateResult,
  type SettingsValidateResult,
  type SettingsView,
} from '@rka/shared';
import { isAbsolute } from 'node:path';
import { type RuntimeConfig } from './runtime-config.js';
import { testSearxng, type OllamaSettingsService } from './services.js';

export interface SettingsServiceDeps {
  readonly config: RuntimeConfig;
  readonly ollama: OllamaSettingsService;
  /** Native folder picker. Returns the chosen folder, or null when cancelled. */
  readonly chooseFolder: (defaultPath: string | null) => Promise<string | null>;
}

/**
 * IPC-facing settings service. Every payload is parsed with Zod and every
 * response validated before it leaves the main process. No method returns a
 * secret: secrets are only reported as "set" / "not set".
 */
export function createSettingsService({ config, ollama, chooseFolder }: SettingsServiceDeps) {
  const result = (value: SettingsUpdateResult) => SettingsUpdateResultSchema.parse(value);
  const url = (payload: unknown) => ServerUrlRequestSchema.parse(payload ?? {}).url;

  return {
    get(): SettingsView {
      return SettingsViewSchema.parse(config.view());
    },

    validate(payload: unknown): SettingsValidateResult {
      return SettingsValidateResultSchema.parse(
        config.validateSettings(SettingsPatchSchema.parse(payload)),
      );
    },

    update(payload: unknown): SettingsUpdateResult {
      return result(config.updateSettings(SettingsPatchSchema.parse(payload)));
    },

    reset(payload: unknown): SettingsUpdateResult {
      const { keys } = SettingsResetRequestSchema.parse(payload ?? {});
      return result(config.resetSettings(keys));
    },

    setSecret(payload: unknown): SettingsUpdateResult {
      const { key, value } = SecretUpdateRequestSchema.parse(payload);
      return result(config.setSecret(key, value));
    },

    async chooseBackupFolder(): Promise<SettingsUpdateResult | { status: 'cancelled' }> {
      const folder = await chooseFolder(config.getSetting('backup.defaultDirectory'));
      if (!folder) return { status: 'cancelled' };
      if (!isAbsolute(folder)) {
        return result({
          status: 'invalid',
          errors: { 'backup.defaultDirectory': 'Choose a folder.' },
        });
      }
      return result(
        config.updateSettings({ 'backup.defaultDirectory': folder }, { internal: true }),
      );
    },

    async testSearxng(payload: unknown): Promise<ConnectionTestResult> {
      return ConnectionTestResultSchema.parse(await testSearxng(config, url(payload)));
    },

    async ollamaTestConnection(payload: unknown): Promise<ConnectionTestResult> {
      return ConnectionTestResultSchema.parse(await ollama.testConnection(url(payload)));
    },

    ollamaConnectionState(): OllamaConnectionState {
      return OllamaConnectionStateSchema.parse(ollama.connectionState());
    },

    ollamaConnect(): OllamaConnectionState {
      return OllamaConnectionStateSchema.parse(ollama.connect());
    },

    ollamaDisconnect(): OllamaConnectionState {
      return OllamaConnectionStateSchema.parse(ollama.disconnect());
    },

    async ollamaListModels(): Promise<OllamaModelList> {
      return OllamaModelListSchema.parse(await ollama.listModels());
    },

    async ollamaShowModel(payload: unknown): Promise<OllamaModelDetails> {
      return OllamaModelDetailsSchema.parse(
        await ollama.showModel(ModelNameRequestSchema.parse(payload).name),
      );
    },

    async ollamaTestModel(payload: unknown): Promise<ModelTestResult> {
      const { name, prompt } = ModelTestRequestSchema.parse(payload);
      return ModelTestResultSchema.parse(await ollama.testModel(name, prompt));
    },

    ollamaEffectiveConfig(): EffectiveModelConfig {
      return EffectiveModelConfigSchema.parse(ollama.effectiveConfig());
    },
  };
}

export type SettingsService = ReturnType<typeof createSettingsService>;
