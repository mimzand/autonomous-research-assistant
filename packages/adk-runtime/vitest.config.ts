import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'adk-runtime',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
