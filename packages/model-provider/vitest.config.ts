import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'model-provider',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
