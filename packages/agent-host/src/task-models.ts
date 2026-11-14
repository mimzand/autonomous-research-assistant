import { type TaskModelConfig } from '@rka/agent-runtime';
import { OllamaConfigSchema, type OllamaProvider } from '@rka/model-provider';

/** Task isolation: research tasks capture the Ollama configuration when they start. */
export function taskModelsFor(provider: OllamaProvider) {
  return {
    capture: (): TaskModelConfig => {
      const config = provider.currentConfig;
      return {
        provider: 'ollama',
        name: config.model,
        url: config.baseUrl,
        config: JSON.parse(JSON.stringify(config)) as TaskModelConfig['config'],
      };
    },
    providerFor: (captured: TaskModelConfig) => {
      const parsed = OllamaConfigSchema.safeParse(captured.config);
      // A stored configuration that is no longer valid falls back to the current one.
      return provider.snapshot(parsed.success ? parsed.data : provider.currentConfig);
    },
  };
}
