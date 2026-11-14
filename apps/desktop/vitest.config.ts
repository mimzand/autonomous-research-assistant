import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'desktop',
    environment: 'node',
    // Renderer tests cover plain TypeScript only (no DOM needed).
    include: ['src/main/**/*.test.ts', 'src/bench/**/*.test.ts', 'src/renderer/src/**/*.test.ts'],
    // Live tests need a running Ollama: run them with `pnpm test:chat:ollama`.
    exclude: ['src/**/*.live.test.ts'],
  },
});
