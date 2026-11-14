import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'agent-client',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
