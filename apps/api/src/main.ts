import { serve } from '@hono/node-server';
import pkg from '../package.json' with { type: 'json' };
import { createAgentLink } from './agent-link.js';
import { createApiApp } from './app.js';
import { loadApiConfig } from './config.js';

/*
 * `pnpm api:dev` (or `pnpm api:up`, with the agent): the Web API on API_HOST:API_PORT
 * (default 127.0.0.1:8787). It reaches the agent through AGENT_STATE_FILE (default:
 * the file `pnpm agent:dev` writes) and never opens the database itself.
 */
function main(): void {
  const config = loadApiConfig(process.env);
  const log = (message: string) => console.info(`[api] ${message}`);
  const agent = createAgentLink({ stateFile: config.agentStateFile, version: pkg.version, log });
  const app = createApiApp({ config, agent, version: pkg.version, log });

  const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
    const base = `http://${info.family === 'IPv6' ? `[${info.address}]` : info.address}:${info.port}`;
    log(`Listening on ${base} (Swagger UI: ${base}/docs).`);
    log(`Agent state file: ${config.agentStateFile}`);
    if (config.apiKeyGenerated) {
      // Development convenience only (loopback): the key is valid for this run.
      log(`API_KEY is not set; generated a key for this run: ${config.apiKey}`);
    }
    void agent
      .ensure()
      .catch(() => log('The agent is not reachable yet; the API connects on the first request.'));
  });

  const shutdown = (signal: string) => {
    log(`${signal}: shutting down.`);
    agent.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2_000).unref();
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) {
    process.once(signal, () => shutdown(signal));
  }
}

try {
  main();
} catch (error) {
  console.error(`[api] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
