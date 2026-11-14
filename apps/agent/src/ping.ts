import { randomUUID } from 'node:crypto';
import pkg from '../package.json' with { type: 'json' };
import { readCliOptions } from './cli.js';
import { connectAgent } from './client.js';
import { readStateFile } from './state-file.js';

/** Dev check: reads the state file, completes the handshake and sends system.ping. */
async function main(): Promise<void> {
  const options = readCliOptions(process.argv.slice(2));
  if (!options) return;

  const read = readStateFile(options.stateFile);
  if (read.status !== 'ok') {
    console.error(
      read.status === 'missing'
        ? `No agent state file at ${options.stateFile}. Start the agent with \`pnpm agent:dev\`.`
        : `The agent state file at ${options.stateFile} is invalid.`,
    );
    process.exitCode = 1;
    return;
  }

  const started = performance.now();
  const client = await connectAgent({
    port: read.state.port,
    token: read.state.token,
    client: { kind: 'cli', version: pkg.version },
  });
  try {
    const nonce = randomUUID();
    const pong = await client.request('system.ping', { nonce });
    if (pong.nonce !== nonce) throw new Error('The agent echoed a different nonce.');
    const ms = Math.round(performance.now() - started);
    console.info(
      `Pong from agent pid ${client.ack.agent.pid} on ${read.state.host}:${read.state.port} ` +
        `(handshake + ping ${ms} ms, agent time ${pong.agentTime}).`,
    );
  } finally {
    client.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  process.exitCode = 1;
});
