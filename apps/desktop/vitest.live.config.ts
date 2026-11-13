import { defineConfig } from 'vitest/config';

/** Live Chat engine comparison against a real Ollama server: `pnpm test:chat:ollama`. */
export default defineConfig({
  test: {
    name: 'desktop:live',
    root: import.meta.dirname,
    environment: 'node',
    include: ['src/main/**/*.live.test.ts'],
    // The first call may load the model into memory.
    testTimeout: 180_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
