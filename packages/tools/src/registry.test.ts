import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createToolRegistry } from './registry.js';
import { defineTool, type ToolPermissions } from './tool.js';

const readOnly: ToolPermissions = {
  network: 'none',
  filesystem: 'none',
  effects: 'read-only',
  requiresApproval: false,
};

const echo = defineTool({
  name: 'echo',
  description: 'Returns its input.',
  inputSchema: z.object({ text: z.string().min(1) }),
  outputSchema: z.object({ echoed: z.string() }),
  timeoutMs: 1000,
  permissions: readOnly,
  execute: async ({ text }) => ({ echoed: text }),
});

const ctx = () => ({ signal: new AbortController().signal });

describe('createToolRegistry', () => {
  it('lists tools with input/output JSON schemas, timeout and permissions', () => {
    const [summary] = createToolRegistry([echo]).list();
    expect(summary).toMatchObject({
      name: 'echo',
      timeoutMs: 1000,
      requiresApproval: false,
      permissions: readOnly,
    });
    expect(summary?.inputJsonSchema).toMatchObject({
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    });
    expect(summary?.outputJsonSchema).toMatchObject({
      properties: { echoed: { type: 'string' } },
    });
    expect(Object.isFrozen(summary)).toBe(true);
  });

  it('validates input before execution', () => {
    const registry = createToolRegistry([echo]);
    expect(registry.parseInput('echo', { text: 'hi' })).toEqual({
      ok: true,
      value: { text: 'hi' },
    });
    const invalid = registry.parseInput('echo', { text: 42 });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error).toMatchObject({ kind: 'invalid-input', name: 'echo' });
  });

  it('rejects unknown tools', () => {
    expect(createToolRegistry([]).parseInput('rm_rf', {})).toEqual({
      ok: false,
      error: { kind: 'unknown-tool', name: 'rm_rf' },
    });
  });

  it('rejects duplicate, badly named or badly configured tools', () => {
    expect(() => createToolRegistry([echo, echo])).toThrow(/Duplicate/);
    expect(() => createToolRegistry([{ ...echo, name: 'Bad Name' }])).toThrow(/Invalid tool name/);
    expect(() => createToolRegistry([{ ...echo, timeoutMs: 0 }])).toThrow(/timeout/);
    expect(() => createToolRegistry([{ ...echo, description: ' ' }])).toThrow(/description/);
    expect(() =>
      createToolRegistry([
        { ...echo, permissions: { ...readOnly, effects: 'external', requiresApproval: false } },
      ]),
    ).toThrow(/must require approval/);
  });
});

describe('registry.execute', () => {
  it('runs a tool with validated input and output', async () => {
    const result = await createToolRegistry([echo]).execute('echo', { text: 'hi' }, ctx());
    expect(result).toEqual({ ok: true, value: { echoed: 'hi' } });
  });

  it('does not run the tool when the input is invalid', async () => {
    let ran = false;
    const tool = { ...echo, execute: async () => ((ran = true), { echoed: 'x' }) };
    const result = await createToolRegistry([tool]).execute('echo', { text: '' }, ctx());
    expect(result).toMatchObject({ ok: false, error: { kind: 'invalid-input' } });
    expect(ran).toBe(false);
  });

  it('rejects output that does not match the output schema', async () => {
    const liar = { ...echo, execute: async () => ({ echoed: 42 }) as never };
    const result = await createToolRegistry([liar]).execute('echo', { text: 'a' }, ctx());
    expect(result).toMatchObject({ ok: false, error: { kind: 'invalid-output' } });
  });

  it('enforces the timeout even if the tool ignores its signal', async () => {
    const slow = {
      ...echo,
      timeoutMs: 30,
      execute: () => new Promise<{ echoed: string }>(() => undefined),
    };
    const started = Date.now();
    const result = await createToolRegistry([slow]).execute('echo', { text: 'a' }, ctx());
    expect(result).toMatchObject({ ok: false, error: { kind: 'timeout' } });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('passes an abort signal and reports cancellation', async () => {
    let seen: AbortSignal | undefined;
    const waits = {
      ...echo,
      execute: (_input: unknown, { signal }: { signal: AbortSignal }) =>
        new Promise<{ echoed: string }>((_resolve, reject) => {
          seen = signal;
          signal.addEventListener('abort', () => reject(new Error('stopped')));
        }),
    };
    const controller = new AbortController();
    const pending = createToolRegistry([waits]).execute(
      'echo',
      { text: 'a' },
      {
        signal: controller.signal,
      },
    );
    controller.abort();
    expect(await pending).toMatchObject({ ok: false, error: { kind: 'cancelled' } });
    expect(seen?.aborted).toBe(true);
  });

  it('reports tool errors with their code', async () => {
    const failing = {
      ...echo,
      execute: async () => {
        throw Object.assign(new Error('Blocked host.'), { code: 'blocked-url' });
      },
    };
    const result = await createToolRegistry([failing]).execute('echo', { text: 'a' }, ctx());
    expect(result).toEqual({
      ok: false,
      error: { kind: 'failed', name: 'echo', message: 'Blocked host.', code: 'blocked-url' },
    });
  });

  it('refuses tools that need approval unless an approval is given', async () => {
    const writer = {
      ...echo,
      permissions: { ...readOnly, effects: 'external' as const, requiresApproval: true },
    };
    const registry = createToolRegistry([writer]);
    expect(await registry.execute('echo', { text: 'a' }, ctx())).toMatchObject({
      ok: false,
      error: { kind: 'approval-required' },
    });
    expect(
      await registry.execute('echo', { text: 'a' }, { ...ctx(), approvalId: 'approval-1' }),
    ).toEqual({ ok: true, value: { echoed: 'a' } });
  });
});
