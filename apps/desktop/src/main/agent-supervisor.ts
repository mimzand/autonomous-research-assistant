import { rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  connectFromStateFile,
  readStateFile,
  type ConnectFromStateFileOptions,
  type StateFileConnection,
} from '@rka/agent-client';
import { toErrorMessage } from '@rka/shared';
import {
  AGENT_STATE_FILE_NAME,
  connectServiceAgent,
  type ServiceAgentConnection,
} from './agent-transport.js';

/*
 * Agent Process Separation Phase 8: Electron supervises the agent service.
 *
 * Runtime: Electron's utilityProcess (a Node.js child of the app executable, not
 * ELECTRON_RUN_AS_NODE, which the runAsNode fuse disables). It loads the bundled
 * agent (out/agent/main.js) from app.asar and better-sqlite3's Node-API binary
 * from app.asar.unpacked, the same file the main process used before.
 *
 * Spawn allow-list (docs/agent-process-security.md): this module is the ONLY place
 * in the app that starts a process. It starts exactly one module, the bundled
 * agent entry under the app path, with fixed arguments (data folder, state file,
 * port 0) built from Electron's own paths. There is no shell, and no user or
 * renderer string ever becomes an argument. The token is not passed at all: the
 * agent generates it and writes it to the owner-only state file in the data folder.
 */

/** The bundled agent entry inside the app (app.asar when packaged). */
export function agentEntryPath(appPath: string): string {
  return join(appPath, 'out', 'agent', 'main.js');
}

/** The only arguments the agent is ever started with. */
export function agentLaunchArgs(paths: {
  readonly dataDir: string;
  readonly stateFile: string;
}): string[] {
  return ['--data-dir', paths.dataDir, '--state-file', paths.stateFile, '--port', '0'];
}

/**
 * The agent's environment: this process's (so .env, settings.env and real variables
 * keep deciding the environment overrides, as in-process), minus anything that
 * changes how the runtime itself starts.
 */
export function agentEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (/^(NODE_OPTIONS|ELECTRON_.*)$/i.test(key)) continue;
    out[key] = value;
  }
  return out;
}

/** What this module needs from Electron's `UtilityProcess`. */
export interface AgentChild {
  readonly pid: number | undefined;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  kill(): boolean;
  once(event: 'spawn', listener: () => void): unknown;
  once(event: 'exit', listener: (code: number) => void): unknown;
}

/** Electron: utilityProcess's fork method, passed through unchanged by index.ts. */
export type ForkAgent = (
  modulePath: string,
  args: string[],
  options: {
    readonly env: Record<string, string>;
    readonly serviceName: string;
    readonly stdio: 'pipe';
  },
) => AgentChild;

export const AGENT_START_TIMEOUT_MS = 30_000;
export const AGENT_STOP_TIMEOUT_MS = 5_000;
const POLL_MS = 50;
const STDERR_TAIL_LINES = 20;

export interface AgentSupervisorDeps {
  readonly fork: ForkAgent;
  /** Electron: `app.getAppPath()`. The entry is always `out/agent/main.js` below it. */
  readonly appPath: string;
  /** Electron: `app.getPath('userData')`. The database is `<dataDir>/data/research.db`. */
  readonly dataDir: string;
  readonly appVersion: string;
  readonly env: NodeJS.ProcessEnv;
  readonly log?: Pick<Console, 'info' | 'warn'>;
  /** Tests: replaces `connectFromStateFile` (control connections and the shell connection). */
  readonly connect?: (
    path: string,
    options: ConnectFromStateFileOptions,
  ) => Promise<StateFileConnection>;
  readonly startTimeoutMs?: number;
  readonly stopTimeoutMs?: number;
}

export interface AgentSupervisor {
  readonly stateFile: string;
  /** Starts the agent and returns the authenticated shell connection (handshake + ping done). */
  start(): Promise<ServiceAgentConnection>;
  /**
   * Stops the agent: `system.shutdown` on a control connection, then waits for the
   * process to exit; kills it if it does not. Never throws. Idempotent.
   */
  stop(): Promise<void>;
}

export function createAgentSupervisor(deps: AgentSupervisorDeps): AgentSupervisor {
  const log = deps.log ?? console;
  const connect = deps.connect ?? connectFromStateFile;
  const stateFile = join(deps.dataDir, AGENT_STATE_FILE_NAME);
  const stopTimeoutMs = deps.stopTimeoutMs ?? AGENT_STOP_TIMEOUT_MS;
  let child: AgentChild | undefined;
  let exited: Promise<number> | undefined;
  let exitCode: number | undefined;
  let stopping: Promise<void> | undefined;
  const stderrTail: string[] = [];

  /** Asks the agent that owns the state file to stop. Resolves whether it accepted. */
  async function requestShutdown(): Promise<boolean> {
    let connection: StateFileConnection | undefined;
    try {
      connection = await connect(stateFile, {
        client: { kind: 'shell', version: deps.appVersion },
        timeoutMs: 2_000,
      });
      await connection.client.request('system.shutdown', {}, { timeoutMs: 2_000 });
      return true;
    } catch {
      return false;
    } finally {
      connection?.client.close();
    }
  }

  /** Removes the state file if it is ours (written by `pid`) or no longer usable. */
  function clearStateFile(pid?: number): void {
    const read = readStateFile(stateFile);
    if (read.status === 'missing') return;
    if (pid === undefined || read.status === 'invalid' || read.state.pid === pid) {
      rmSync(stateFile, { force: true });
    }
  }

  /**
   * A state file left by an earlier run: an agent that is still answering (the app
   * crashed and left it running) is asked to stop; anything else is stale.
   */
  async function clearPreviousAgent(): Promise<void> {
    const read = readStateFile(stateFile);
    if (read.status === 'missing') return;
    if (read.status === 'ok' && (await requestShutdown())) {
      log.info('Agent service: stopped an agent left running by an earlier run.');
      const end = Date.now() + stopTimeoutMs;
      while (readStateFile(stateFile).status !== 'missing' && Date.now() < end)
        await sleep(POLL_MS);
    }
    clearStateFile();
  }

  function forward(stream: NodeJS.ReadableStream | null, write: (line: string) => void): void {
    if (!stream) return;
    let buffered = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      buffered += chunk;
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) write(line);
    });
  }

  async function waitForStateFile(pid: number | undefined): Promise<void> {
    const end = Date.now() + (deps.startTimeoutMs ?? AGENT_START_TIMEOUT_MS);
    for (;;) {
      if (exitCode !== undefined) {
        const detail = stderrTail.length ? ` ${stderrTail.join(' | ')}` : '';
        throw new Error(`The agent service exited during startup (code ${exitCode}).${detail}`);
      }
      const read = readStateFile(stateFile);
      if (read.status === 'ok' && (pid === undefined || read.state.pid === pid)) return;
      if (Date.now() > end) throw new Error('The agent service did not start in time.');
      await sleep(POLL_MS);
    }
  }

  return {
    stateFile,

    async start() {
      if (child) throw new Error('The agent service is already started.');
      await clearPreviousAgent();
      const entry = agentEntryPath(deps.appPath);
      const forked = deps.fork(entry, agentLaunchArgs({ dataDir: deps.dataDir, stateFile }), {
        env: agentEnvironment(deps.env),
        serviceName: 'Research Agent',
        stdio: 'pipe',
      });
      child = forked;
      exited = new Promise<number>((resolve) =>
        forked.once('exit', (code) => {
          exitCode = code;
          resolve(code);
        }),
      );
      void exited.then((code) => {
        if (!stopping) {
          log.warn(
            `Agent service stopped unexpectedly (code ${code}). Requests to the agent fail until the app restarts.`,
          );
        }
      });
      forward(forked.stdout, (line) => log.info(line));
      forward(forked.stderr, (line) => {
        stderrTail.push(line);
        if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();
        log.warn(line);
      });
      await new Promise<void>((resolve) => {
        if (forked.pid !== undefined) resolve();
        else forked.once('spawn', () => resolve());
        void exited?.then(() => resolve());
      });
      await waitForStateFile(forked.pid);
      return connectServiceAgent({
        stateFile,
        appVersion: deps.appVersion,
        ...(deps.connect && { connect: deps.connect }),
        hint: 'The app started the agent but cannot reach it; restart the app.',
      });
    },

    stop() {
      stopping ??= (async () => {
        const running = child;
        if (!running || exitCode !== undefined) return clearStateFile(running?.pid);
        const accepted = await requestShutdown();
        const done = await race(exited, accepted ? stopTimeoutMs : 0);
        if (!done) {
          log.warn('Agent service: did not stop in time; ending the process.');
          running.kill();
          await race(exited, stopTimeoutMs);
        }
        // A clean stop removes the file itself; a killed agent leaves it behind.
        clearStateFile(running.pid);
      })().catch((error: unknown) => {
        log.warn(`Agent service: stopping failed: ${toErrorMessage(error)}`);
      });
      return stopping;
    },
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Resolves true when `promise` settles within `ms`, false otherwise. */
async function race(promise: Promise<unknown> | undefined, ms: number): Promise<boolean> {
  if (!promise) return true;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), ms)));
  try {
    return await Promise.race([promise.then(() => true as const), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
