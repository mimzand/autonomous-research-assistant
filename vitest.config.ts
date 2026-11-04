import { defineConfig } from 'vitest/config';

// Root config: runs every workspace project. Each project owns its own
// vitest.config.ts, so `pnpm test` inside a package also works.
export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/desktop'],
  },
});
