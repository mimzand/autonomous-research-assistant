import { AgentStateFileSchema, type AgentStateFile } from '@rka/agent-protocol';
import { readFileSync } from 'node:fs';

const MAX_STATE_FILE_BYTES = 64 * 1024;

export type StateFileRead =
  | { readonly status: 'ok'; readonly state: AgentStateFile }
  | { readonly status: 'missing' }
  | { readonly status: 'invalid' };

/**
 * Reads and validates an agent connection state file. A file that names any host
 * other than 127.0.0.1 is `invalid` (AgentStateFileSchema.host is a literal).
 */
export function readStateFile(path: string): StateFileRead {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' };
    return { status: 'invalid' };
  }
  if (text.length > MAX_STATE_FILE_BYTES) return { status: 'invalid' };
  try {
    const parsed = AgentStateFileSchema.safeParse(JSON.parse(text));
    return parsed.success ? { status: 'ok', state: parsed.data } : { status: 'invalid' };
  } catch {
    return { status: 'invalid' };
  }
}

/** Whether a process with this id exists (signal 0 sends nothing). */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === 'EPERM';
  }
}
