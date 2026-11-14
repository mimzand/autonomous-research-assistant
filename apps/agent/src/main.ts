import pkg from '../package.json' with { type: 'json' };
import { readCliOptions } from './cli.js';
import { runAgent } from './run.js';
import { openAgentServices } from './services.js';

async function main(): Promise<void> {
  const options = readCliOptions(process.argv.slice(2));
  if (!options) return;

  const log = (message: string) => console.info(`[agent] ${message}`);
  const agent = await runAgent({
    port: options.port,
    stateFile: options.stateFile,
    agentVersion: pkg.version,
    openServices: () => {
      const services = openAgentServices({ dataDir: options.dataDir, env: process.env, log });
      log(`Database: ${services.databasePath}`);
      return services;
    },
    log,
  });
  console.info(
    `[agent] Listening on ${agent.server.host}:${agent.server.port} (pid ${process.pid}).`,
  );
  console.info(`[agent] State file: ${agent.stateFile}`);

  const shutdown = (signal: string) => {
    console.info(`[agent] ${signal}: shutting down.`);
    void agent.stop().then(() => process.exit(0));
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) {
    process.once(signal, () => shutdown(signal));
  }
}

main().catch((error: unknown) => {
  console.error(`[agent] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
