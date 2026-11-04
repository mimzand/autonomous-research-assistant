import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'desktop',
    environment: 'node',
    // Renderer tests cover plain TypeScript only (no DOM needed).
    include: ['src/main/**/*.test.ts', 'src/renderer/src/**/*.test.ts'],
  },
});
