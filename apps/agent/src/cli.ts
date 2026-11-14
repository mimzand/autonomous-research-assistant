import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { STATE_FILE_NAME } from './state-file.js';

/** Dev default (gitignored); holds its own database, separate from the desktop app's. */
export const DEFAULT_DATA_DIR = fileURLToPath(new URL('../.agent-data', import.meta.url));

export const USAGE = `Usage: agent [options]
  --data-dir <dir>     Agent data folder, laid out like the app's userData: the
                       database is <data-dir>/data/research.db
                       (default: apps/agent/.agent-data)
  --state-file <path>  Connection state file (default: <data-dir>/${STATE_FILE_NAME})
  --port <n>           TCP port on 127.0.0.1; 0 = ephemeral (default: 0)
  --help               Show this help`;

export class CliUsageError extends Error {
  override readonly name = 'CliUsageError';
}

const ArgsSchema = z.strictObject({
  'data-dir': z.string().trim().min(1).max(1024).optional(),
  'state-file': z.string().trim().min(1).max(1024).optional(),
  port: z
    .string()
    .regex(/^\d{1,5}$/, 'must be a whole number')
    .transform(Number)
    .pipe(z.int().max(65_535))
    .optional(),
  help: z.boolean().optional(),
});

export interface AgentCliOptions {
  readonly dataDir: string;
  readonly stateFile: string;
  readonly port: number;
  readonly help: boolean;
}

export function parseCliArgs(argv: readonly string[]): AgentCliOptions {
  let values: unknown;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      strict: true,
      allowPositionals: false,
      options: {
        'data-dir': { type: 'string' },
        'state-file': { type: 'string' },
        port: { type: 'string' },
        help: { type: 'boolean' },
      },
    }));
  } catch (cause) {
    throw new CliUsageError(cause instanceof Error ? cause.message : String(cause));
  }
  const parsed = ArgsSchema.safeParse({ ...(values as object) });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new CliUsageError(`Invalid --${String(issue?.path[0])}: ${issue?.message ?? 'invalid'}`);
  }
  const dataDir = resolve(parsed.data['data-dir'] ?? DEFAULT_DATA_DIR);
  return {
    dataDir,
    stateFile: resolve(parsed.data['state-file'] ?? join(dataDir, STATE_FILE_NAME)),
    port: parsed.data.port ?? 0,
    help: parsed.data.help ?? false,
  };
}

/** Parses argv for a CLI entry; prints usage and sets exit code 2 on bad input. */
export function readCliOptions(argv: readonly string[]): AgentCliOptions | null {
  try {
    const options = parseCliArgs(argv);
    if (options.help) {
      console.info(USAGE);
      return null;
    }
    return options;
  } catch (error) {
    if (!(error instanceof CliUsageError)) throw error;
    console.error(error.message);
    console.error(USAGE);
    process.exitCode = 2;
    return null;
  }
}
