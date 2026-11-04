import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'agent-runtime',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
