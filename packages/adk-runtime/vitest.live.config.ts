import { defineConfig } from 'vitest/config';

/** Live ADK tests against a real Ollama server: `pnpm test:adk:ollama`. */
export default defineConfig({
  test: {
    name: 'adk-runtime:live',
    root: import.meta.dirname,
    environment: 'node',
    include: ['src/**/*.live.test.ts'],
    // The first call may load the model into memory.
    testTimeout: 180_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
