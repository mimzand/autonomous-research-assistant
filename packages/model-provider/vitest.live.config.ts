import { defineConfig } from 'vitest/config';

/** Live tests against a real Ollama server: `pnpm test:ollama`. */
export default defineConfig({
  test: {
    name: 'model-provider:live',
    root: import.meta.dirname,
    environment: 'node',
    include: ['src/**/*.live.test.ts'],
    // First call loads the model into memory (~30 s on a 6 GB GPU).
    testTimeout: 180_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
