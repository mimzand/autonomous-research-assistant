import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createToolRegistry } from './registry.js';
import { defineTool } from './tool.js';

const echo = defineTool({
  name: 'echo',
  description: 'Returns its input.',
  inputSchema: z.object({ text: z.string().min(1) }),
  requiresApproval: false,
  execute: async ({ text }) => text,
});

describe('createToolRegistry', () => {
  it('lists tools with a JSON schema for the model', () => {
    const [summary] = createToolRegistry([echo]).list();
    expect(summary).toMatchObject({ name: 'echo', requiresApproval: false });
    expect(summary?.inputJsonSchema).toMatchObject({
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    });
  });

  it('validates input before execution', () => {
    const registry = createToolRegistry([echo]);
    expect(registry.parseInput('echo', { text: 'hi' })).toEqual({
      ok: true,
      value: { text: 'hi' },
    });

    const invalid = registry.parseInput('echo', { text: 42 });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.error).toMatchObject({ kind: 'invalid-input', name: 'echo' });
    }
  });

  it('rejects unknown tools', () => {
    expect(createToolRegistry([]).parseInput('rm_rf', {})).toEqual({
      ok: false,
      error: { kind: 'unknown-tool', name: 'rm_rf' },
    });
  });

  it('rejects duplicate and badly named tools', () => {
    expect(() => createToolRegistry([echo, echo])).toThrow(/Duplicate/);
    expect(() => createToolRegistry([{ ...echo, name: 'Bad Name' }])).toThrow(/Invalid tool name/);
  });
});
