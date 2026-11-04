import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'model-provider',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Live tests need a running Ollama: run them with `pnpm test:ollama`.
    exclude: ['src/**/*.live.test.ts'],
  },
});
