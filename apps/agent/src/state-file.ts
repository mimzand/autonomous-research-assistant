import { readStateFile } from '@rka/agent-client';
import { AgentStateFileSchema, type AgentStateFile } from '@rka/agent-protocol';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { tokensEqual } from './token.js';

export const STATE_FILE_NAME = 'agent-state.json';

/**
 * Writes the connection state atomically (temp file + rename), so a reader never
 * sees a partial file. POSIX: owner-only mode 0600 in a 0700 folder. Windows ignores
 * the mode; the file then relies on the per-user ACL of the data folder (the user
 * profile / %APPDATA%), which other non-admin users cannot read.
 */
export function writeStateFile(path: string, state: AgentStateFile): void {
  const json = JSON.stringify(AgentStateFileSchema.parse(state), null, 2);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, json, { encoding: 'utf8', mode: 0o600 });
  renameSync(temp, path);
}

/**
 * Removes the state file only if it still holds `token`, i.e. it was written by this
 * agent run and not replaced by a newer one. Returns whether the file was removed.
 */
export function removeStateFile(path: string, token: string): boolean {
  const current = readStateFile(path);
  if (current.status !== 'ok' || !tokensEqual(current.state.token, token)) return false;
  rmSync(path, { force: true });
  return true;
}
