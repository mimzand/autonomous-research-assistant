import { InMemorySessionService, LlmAgent, type LlmRequest, type LlmResponse } from './adk.js';
import { createGuardedRunner } from './guards.js';
import { LocalLlm } from './local-llm.js';

const PROBE_REPLY = 'adk-self-check-ok';

/**
 * Offline stand-in model for the self-check: answers with a fixed text and
 * never touches the network or Ollama.
 */
class ProbeLlm extends LocalLlm {
  constructor() {
    super({ model: 'rka-self-check-probe' });
  }

  override async *generateContentAsync(
    _request: LlmRequest,
    _stream?: boolean,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    abortSignal?.throwIfAborted();
    yield { content: { role: 'model', parts: [{ text: PROBE_REPLY }] }, turnComplete: true };
  }
}

export interface AdkSelfCheckResult {
  readonly ok: boolean;
  readonly durationMs: number;
  readonly error?: string;
}

/**
 * Runs one turn through ADK's Runner with an in-memory session and the offline
 * probe model, proving the ADK runtime works in this process (e.g. Electron
 * main). Never throws.
 */
export async function runAdkSelfCheck(): Promise<AdkSelfCheckResult> {
  const started = performance.now();
  try {
    const sessionService = new InMemorySessionService();
    const runner = createGuardedRunner({
      appName: 'rka-self-check',
      agent: new LlmAgent({
        name: 'self_check',
        model: new ProbeLlm(),
        instruction: 'Reply with the fixed self-check text.',
      }),
      sessionService,
    });
    const session = await sessionService.createSession({
      appName: 'rka-self-check',
      userId: 'local',
    });
    let reply = '';
    for await (const event of runner.runAsync({
      userId: 'local',
      sessionId: session.id,
      newMessage: { role: 'user', parts: [{ text: 'ping' }] },
    })) {
      if (event.errorCode) throw new Error(`${event.errorCode}: ${event.errorMessage ?? ''}`);
      reply += event.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    }
    if (reply !== PROBE_REPLY)
      throw new Error(`Unexpected self-check reply: ${JSON.stringify(reply)}`);
    return { ok: true, durationMs: Math.round(performance.now() - started) };
  } catch (error) {
    return {
      ok: false,
      durationMs: Math.round(performance.now() - started),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
