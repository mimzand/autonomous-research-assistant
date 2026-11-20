import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'agent-protocol',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
