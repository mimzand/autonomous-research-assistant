import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'agent-host',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
