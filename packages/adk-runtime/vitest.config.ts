import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'adk-runtime',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Live tests need a running Ollama: run them with `pnpm test:adk:ollama`.
    exclude: ['src/**/*.live.test.ts'],
  },
});
