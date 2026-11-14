import { randomUUID } from 'node:crypto';
import { connectFromStateFile } from '@rka/agent-client';
import pkg from '../package.json' with { type: 'json' };
import { readCliOptions } from './cli.js';

/** Dev check: reads the state file, completes the handshake and sends system.ping. */
async function main(): Promise<void> {
  const options = readCliOptions(process.argv.slice(2));
  if (!options) return;

  const started = performance.now();
  const { client, state } = await connectFromStateFile(options.stateFile, {
    client: { kind: 'cli', version: pkg.version },
  });
  try {
    const nonce = randomUUID();
    const pong = await client.request('system.ping', { nonce });
    if (pong.nonce !== nonce) throw new Error('The agent echoed a different nonce.');
    const ms = Math.round(performance.now() - started);
    console.info(
      `Pong from agent pid ${client.ack.agent.pid} on ${state.host}:${state.port} ` +
        `(handshake + ping ${ms} ms, agent time ${pong.agentTime}).`,
    );
  } finally {
    client.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  console.error('Start the agent with `pnpm agent:dev`.');
  process.exitCode = 1;
});
