/*
 * Authoritative outcomes at the application boundary: the real ADK Runner,
 * OllamaLlm, OllamaProvider (real HTTP to a fake Ollama), the ToolRegistry and
 * RegistryTool. The scripted model deliberately lies about what happened, in
 * several languages; the authoritative result must follow what really happened.
 */
import { createOllamaProvider, loadOllamaConfig } from '@rka/model-provider';
import { createToolRegistry, defineTool, type ToolContext } from '@rka/tools';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { type Event, InMemorySessionService, LlmAgent } from '../adk.js';
import { createGuardedRunner } from '../guards.js';
import { OllamaLlm } from '../ollama/ollama-llm.js';
import {
  chunk,
  type ChatBody,
  type FakeOllama,
  reply,
  startFakeOllama,
} from '../testing/fake-ollama.js';
import { summarizeInvocation, ToolOutcomeTracker, type InvocationResult } from './outcomes.js';
import { type ApprovalResolver, createRegistryTools } from './registry-tool.js';

let ollama: FakeOllama;
beforeAll(async () => (ollama = await startFakeOllama()));
afterAll(() => ollama.close());

const executed = { calculator: vi.fn(), publish: vi.fn(), failing: vi.fn(), slow: vi.fn() };
let slowHook: (context: ToolContext) => Promise<{ value: string }> = () =>
  Promise.resolve({ value: 'x' });

const readOnly = {
  network: 'none',
  filesystem: 'none',
  effects: 'read-only',
  requiresApproval: false,
} as const;
const registry = createToolRegistry([
  defineTool({
    name: 'calculator',
    description: 'Arithmetic on two numbers.',
    inputSchema: z.strictObject({
      operation: z.enum(['add', 'multiply']),
      a: z.number(),
      b: z.number(),
    }),
    outputSchema: z.object({ result: z.number() }),
    timeoutMs: 1000,
    permissions: readOnly,
    execute: ({ operation, a, b }) => {
      executed.calculator({ operation, a, b });
      return Promise.resolve({ result: operation === 'add' ? a + b : a * b });
    },
  }),
  defineTool({
    name: 'publish_note',
    description: 'Publishes a note outside the app.',
    inputSchema: z.strictObject({ text: z.string().min(1) }),
    outputSchema: z.object({ published: z.boolean() }),
    timeoutMs: 1000,
    permissions: {
      network: 'public-web',
      filesystem: 'none',
      effects: 'external',
      requiresApproval: true,
    },
    execute: (input) => {
      executed.publish(input);
      return Promise.resolve({ published: true });
    },
  }),
  defineTool({
    name: 'failing_fetch',
    description: 'Fails.',
    inputSchema: z.strictObject({ url: z.string() }),
    outputSchema: z.object({ ok: z.boolean() }),
    timeoutMs: 1000,
    permissions: { ...readOnly, network: 'public-web' },
    execute: () => {
      executed.failing();
      return Promise.reject<{ ok: boolean }>(
        Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' }),
      );
    },
  }),
  defineTool({
    name: 'slow_lookup',
    description: 'Slow.',
    inputSchema: z.strictObject({ key: z.string() }),
    outputSchema: z.object({ value: z.string() }),
    timeoutMs: 200,
    permissions: readOnly,
    execute: (_input, context) => {
      executed.slow();
      return slowHook(context);
    },
  }),
]);

interface Call {
  readonly id: string;
  readonly name: string;
  readonly args: unknown;
}

/** Asks for `calls`, then answers with `finalText` whatever the tool results were. */
function lyingModel(calls: readonly Call[], finalText: string) {
  return (body: ChatBody, res: Parameters<typeof reply>[1]) => {
    if (body.messages.at(-1)?.['role'] === 'tool' || calls.length === 0) {
      return reply(body, res, [chunk(finalText, true)]);
    }
    return reply(body, res, [
      chunk('', false, {
        message: {
          tool_calls: calls.map((c, index) => ({
            id: c.id,
            function: { index, name: c.name, arguments: c.args },
          })),
        },
      }),
      chunk('', true),
    ]);
  };
}

async function run(
  allow: string[],
  model: ReturnType<typeof lyingModel>,
  options: { approvals?: ApprovalResolver; signal?: AbortSignal } = {},
): Promise<InvocationResult> {
  Object.values(executed).forEach((s) => s.mockClear());
  ollama.setChat(model);
  const outcomes = new ToolOutcomeTracker();
  const tools = createRegistryTools(registry, {
    allow,
    limits: {
      maxCallsPerInvocation: 5,
      maxCallDurationMs: 2000,
      maxResultBytes: 10_000,
      maxIdenticalCalls: 1,
    },
    outcomes,
    ...(options.approvals && { approvals: options.approvals }),
  });
  const sessionService = new InMemorySessionService();
  const runner = createGuardedRunner({
    appName: 'outcomes',
    agent: new LlmAgent({
      name: 'assistant',
      model: new OllamaLlm({
        provider: createOllamaProvider(loadOllamaConfig({ OLLAMA_HOST: ollama.baseUrl }), {
          allowToolCalls: true,
        }),
      }),
      instruction: 'Help the user.',
      tools,
    }),
    sessionService,
    registryTools: tools,
  });
  const session = await sessionService.createSession({ appName: 'outcomes', userId: 'local' });
  const events: Event[] = [];
  for await (const event of runner.runAsync({
    userId: 'local',
    sessionId: session.id,
    newMessage: { role: 'user', parts: [{ text: 'Please do it.' }] },
    ...(options.signal && { abortSignal: options.signal }),
  })) {
    events.push(event);
  }
  return summarizeInvocation(events, outcomes);
}

const publish = (id = 'p1'): Call => ({ id, name: 'publish_note', args: { text: 'hello' } });
const multiply = (id = 'c1'): Call => ({
  id,
  name: 'calculator',
  args: { operation: 'multiply', a: 125, b: 48 },
});

/** False completion/approval claims in several languages. */
const FALSE_CLAIMS = [
  'The note has been approved. Let me publish it for you. Done!',
  'یادداشت تأیید شد و با موفقیت منتشر شد.',
  'Die Notiz wurde genehmigt und erfolgreich veröffentlicht.',
  '笔记已获批准并已成功发布。',
  'La nota fue aprobada y publicada correctamente.',
];

function expectNoModelClaims(result: InvocationResult, claim: string) {
  expect(result.modelText).toBeUndefined();
  expect(result.message).not.toContain(claim);
  // The raw text is kept for diagnostics only.
  expect(result.diagnostics.rawModelText).toBe(claim);
}

describe('authoritative tool outcomes (real ADK Runner)', () => {
  it.each(FALSE_CLAIMS)('1/4. model falsely claims approval and publication: %s', async (claim) => {
    const result = await run(['publish_note'], lyingModel([publish()], claim));
    expect(executed.publish).not.toHaveBeenCalled();
    expect(result.status).toBe('approval_required');
    expect(result.message).toBe('Not done: "publish_note" needs your approval and was not run.');
    expect(result.outcomes).toEqual([
      expect.objectContaining({
        callId: 'p1',
        tool: 'publish_note',
        status: 'approval_required',
        approval: 'required',
        executionStarted: false,
        succeeded: false,
      }),
    ]);
    expectNoModelClaims(result, claim);
  });

  it('2. model falsely claims success after the tool failed', async () => {
    const claim = 'I fetched the page successfully. Everything worked.';
    const result = await run(
      ['failing_fetch'],
      lyingModel([{ id: 'f1', name: 'failing_fetch', args: { url: 'https://x' } }], claim),
    );
    expect(executed.failing).toHaveBeenCalledOnce();
    expect(result.status).toBe('failed');
    expect(result.outcomes[0]).toMatchObject({
      status: 'failed',
      executionStarted: true,
      succeeded: false,
    });
    expectNoModelClaims(result, claim);
  });

  it('3. model claims failure after the tool actually succeeded: the status follows the tool', async () => {
    const claim = 'Sorry, the calculator failed and I could not compute it.';
    const result = await run(['calculator'], lyingModel([multiply()], claim));
    expect(executed.calculator).toHaveBeenCalledOnce();
    expect(result.status).toBe('completed');
    expect(result.message).toBe('Done: "calculator" completed successfully.');
    expect(result.outcomes[0]).toMatchObject({
      status: 'ok',
      executionStarted: true,
      succeeded: true,
    });
    // The model's words are passed on only as its answer; the status is the fact.
    expect(result.modelText).toBe(claim);
  });

  it('5. approval denied: not executed, authoritative denied status', async () => {
    const claim = 'Published!';
    const result = await run(['publish_note'], lyingModel([publish()], claim), {
      approvals: { resolve: () => Promise.resolve({ status: 'denied' }) },
    });
    expect(executed.publish).not.toHaveBeenCalled();
    expect(result.status).toBe('approval_denied');
    expect(result.outcomes[0]).toMatchObject({
      approval: 'denied',
      executionStarted: false,
      succeeded: false,
    });
    expectNoModelClaims(result, claim);
  });

  it('approval granted: executed, completed', async () => {
    const result = await run(['publish_note'], lyingModel([publish()], 'Published.'), {
      approvals: { resolve: () => Promise.resolve({ status: 'approved', approvalId: 'a1' }) },
    });
    expect(executed.publish).toHaveBeenCalledOnce();
    expect(result.status).toBe('completed');
    expect(result.outcomes[0]).toMatchObject({
      approval: 'granted',
      executionStarted: true,
      succeeded: true,
    });
  });

  it('6. tool execution fails', async () => {
    const result = await run(
      ['failing_fetch'],
      lyingModel([{ id: 'f1', name: 'failing_fetch', args: { url: 'https://x' } }], 'ok'),
    );
    expect(result).toMatchObject({
      status: 'failed',
      message: 'The request failed: "failing_fetch" did not complete successfully.',
    });
  });

  it('7. tool execution times out', async () => {
    slowHook = (context) =>
      new Promise((_r, reject) =>
        context.signal.addEventListener('abort', () => reject(new Error('stop')), { once: true }),
      );
    const result = await run(
      ['slow_lookup'],
      lyingModel([{ id: 's1', name: 'slow_lookup', args: { key: 'k' } }], 'Found it!'),
    );
    expect(result.status).toBe('failed');
    expect(result.outcomes[0]).toMatchObject({
      status: 'timeout',
      executionStarted: true,
      succeeded: false,
    });
    expect(result.modelText).toBeUndefined();
  });

  it('8. tool execution is cancelled', async () => {
    const controller = new AbortController();
    slowHook = (context) =>
      new Promise((_r, reject) => {
        controller.abort();
        context.signal.addEventListener('abort', () => reject(new Error('stop')), { once: true });
      });
    const result = await run(
      ['slow_lookup'],
      lyingModel([{ id: 's1', name: 'slow_lookup', args: { key: 'k' } }], 'Done!'),
      {
        signal: controller.signal,
      },
    );
    expect(result.status).toBe('cancelled');
    expect(result.message).toBe('The request was cancelled. No result is reported as completed.');
    expect(result.outcomes[0]).toMatchObject({ status: 'cancelled', succeeded: false });
    expect(result.modelText).toBeUndefined();
  });

  it('9. mixed outcomes are reported individually', async () => {
    const partial = await run(
      ['calculator', 'failing_fetch'],
      lyingModel(
        [multiply('c1'), { id: 'f1', name: 'failing_fetch', args: { url: 'https://x' } }],
        'All done!',
      ),
    );
    expect(partial.status).toBe('partially_completed');
    expect(partial.message).toBe('Partly done: "calculator" completed; "failing_fetch" did not.');
    expect(partial.outcomes.map((o) => [o.callId, o.status, o.succeeded])).toEqual([
      ['c1', 'ok', true],
      ['f1', 'failed', false],
    ]);
    expect(partial.modelText).toBeUndefined();

    // A missing approval outranks a partial success.
    const blocked = await run(
      ['calculator', 'publish_note'],
      lyingModel([multiply('c2'), publish('p2')], 'Everything is published.'),
    );
    expect(executed.calculator).toHaveBeenCalledOnce();
    expect(executed.publish).not.toHaveBeenCalled();
    expect(blocked.status).toBe('approval_required');
    expect(blocked.outcomes.map((o) => [o.callId, o.status])).toEqual([
      ['c2', 'ok'],
      ['p2', 'approval_required'],
    ]);
  });

  it('10. the model attempts an undeclared tool: failed, nothing executed', async () => {
    const result = await run(
      ['calculator'],
      lyingModel([{ id: 'x1', name: 'run_shell', args: { cmd: 'whoami' } }], 'Ran it.'),
    );
    expect(result.status).toBe('failed');
    expect(result.diagnostics.errorCodes).toEqual(['OLLAMA_INVALID_TOOL_CALL']);
    expect(result.outcomes).toEqual([]);
    expect(result.modelText).toBeUndefined();
    expect(executed.calculator).not.toHaveBeenCalled();
  });

  it('11. no tool requested: completed, and the app says no tool was run', async () => {
    const claim = 'I have published your note.';
    const result = await run(['publish_note'], lyingModel([], claim));
    expect(executed.publish).not.toHaveBeenCalled();
    expect(result.status).toBe('completed');
    expect(result.outcomes).toEqual([]);
    expect(result.message).toBe('Answered without running any tools.');
    expect(result.modelText).toBe(claim);
  });

  it('12. a legitimate tool call completes normally', async () => {
    const result = await run(['calculator'], lyingModel([multiply()], '125 × 48 = 6000.'));
    expect(result).toMatchObject({
      status: 'completed',
      message: 'Done: "calculator" completed successfully.',
      modelText: '125 × 48 = 6000.',
      outcomes: [
        {
          callId: 'c1',
          tool: 'calculator',
          status: 'ok',
          approval: 'not_required',
          executionStarted: true,
          succeeded: true,
        },
      ],
    });
  });

  it('call limits produce limit_exceeded', async () => {
    const result = await run(
      ['calculator'],
      lyingModel([multiply('c1'), multiply('c2')], 'Both done.'),
    );
    // The identical second call is refused.
    expect(result.status).toBe('limit_exceeded');
    expect(result.outcomes.map((o) => o.status)).toEqual(['ok', 'duplicate_call']);
    expect(result.modelText).toBeUndefined();
  });
});

describe('summarizeInvocation without a run', () => {
  it('a function call that never reached a tool is reported as not executed', () => {
    const events = [
      {
        invocationId: 'i1',
        author: 'a',
        content: {
          role: 'model',
          parts: [{ functionCall: { id: 'z1', name: 'publish_note', args: {} } }],
        },
      },
      {
        invocationId: 'i1',
        author: 'a',
        content: { role: 'model', parts: [{ text: 'Published!' }] },
      },
    ] as unknown as Event[];
    const result = summarizeInvocation(events, new ToolOutcomeTracker());
    expect(result.status).toBe('failed');
    expect(result.outcomes).toEqual([
      expect.objectContaining({ callId: 'z1', status: 'not_executed', executionStarted: false }),
    ]);
    expect(result.modelText).toBeUndefined();
  });

  it('redacts secrets in the diagnostic copy of the model text', () => {
    const events = [
      {
        invocationId: 'i2',
        author: 'a',
        content: { role: 'model', parts: [{ text: 'token: Bearer abcdefghijklmnopqrst' }] },
      },
    ] as unknown as Event[];
    expect(
      summarizeInvocation(events, new ToolOutcomeTracker()).diagnostics.rawModelText,
    ).not.toContain('abcdefghijklmnopqrst');
  });
});
