/**
 * Architecture guards for the agent and main process. These scan the source
 * so that a forbidden capability cannot be added without a failing test:
 * - no shell / process execution anywhere in shipped code,
 * - no model downloads (the app never calls Ollama's pull/push/create/delete),
 * - no file deletion except the backup's own temporary file,
 * - no dynamic code evaluation,
 * - external links opened only through the checked helpers,
 * - the preload exposes exactly one frozen API object and never ipcRenderer itself.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const repo = join(import.meta.dirname, '..', '..', '..', '..');
const roots = [
  'apps/desktop/src',
  'packages/agent-runtime/src',
  'packages/model-provider/src',
  'packages/storage/src',
  'packages/tools/src',
  'packages/shared/src',
];

function shipped(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return shipped(path);
    const isSource = /\.(ts|vue)$/.test(entry.name);
    // Separator-independent (Windows paths use backslashes).
    const isTestOnly =
      /\.test\.ts$/.test(entry.name) || /^(testing|test-fixtures)\.ts$/.test(entry.name);
    return isSource && !isTestOnly ? [path] : [];
  });
}

const files = roots.flatMap((root) => shipped(join(repo, root)));
const rel = (file: string) => relative(repo, file).replace(/\\/g, '/');

function offenders(pattern: RegExp, allowed: readonly string[] = []): string[] {
  return files
    .filter((file) => !allowed.includes(rel(file)))
    .filter((file) => pattern.test(readFileSync(file, 'utf8')))
    .map(rel);
}

describe('security guards', () => {
  it('scans the shipped sources', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('never executes shell commands or processes', () => {
    expect(
      offenders(
        /child_process|\bexecSync\b|\bexecFile\b|\bspawn\s*\(|\bfork\s*\(|process\.binding|worker_threads/,
      ),
    ).toEqual([]);
  });

  it('never downloads, creates or deletes Ollama models', () => {
    expect(offenders(/\/api\/(pull|push|create|delete|copy|blobs)\b/)).toEqual([]);
  });

  it('deletes no files except the backup temporary file', () => {
    expect(
      offenders(/\b(rmSync|unlinkSync|rmdirSync|unlink|rmdir)\s*\(|fs\.rm\(|\.rm\(/, [
        'packages/storage/src/inspect.ts',
      ]),
    ).toEqual([]);
    // inspect.ts removes only its own `<target>.partial-*` file after a failed backup.
    const inspect = readFileSync(join(repo, 'packages/storage/src/inspect.ts'), 'utf8');
    expect(inspect.match(/rmSync\(([^,)]+)/g)).toEqual(['rmSync(temp']);
  });

  it('never evaluates dynamic code', () => {
    expect(offenders(/\beval\s*\(|new\s+Function\s*\(|vm\.run/)).toEqual([]);
  });

  it('opens external links only from the checked call sites', () => {
    expect(
      offenders(/openExternal\s*\(|openPath\s*\(|showItemInFolder\s*\(/, [
        'apps/desktop/src/main/index.ts',
        'apps/desktop/src/main/window.ts',
        'apps/desktop/src/main/research-tools.ts',
      ]),
    ).toEqual([]);
  });

  it('exposes one frozen API object from the preload and never ipcRenderer', () => {
    const preload = readFileSync(join(repo, 'apps/desktop/src/preload/index.ts'), 'utf8');
    expect(preload.match(/exposeInMainWorld\(/g)).toHaveLength(1);
    expect(preload).toMatch(/exposeInMainWorld\(RENDERER_API_KEY, Object\.freeze\(api\)\)/);
    expect(preload).not.toMatch(/exposeInMainWorld\([^)]*ipcRenderer/);
    // Every invoke goes through a fixed channel constant, never a renderer-supplied name.
    expect(preload).not.toMatch(/ipcRenderer\.invoke\((?!channel\b|IpcChannels\.)/);
  });

  it('keeps every BrowserWindow isolated and sandboxed', () => {
    const window = readFileSync(join(repo, 'apps/desktop/src/main/window.ts'), 'utf8');
    for (const setting of [
      'contextIsolation: true',
      'nodeIntegration: false',
      'nodeIntegrationInWorker: false',
      'nodeIntegrationInSubFrames: false',
      'sandbox: true',
      'webSecurity: true',
      'allowRunningInsecureContent: false',
      'webviewTag: false',
    ]) {
      expect(window).toContain(setting);
    }
    expect(offenders(/new BrowserWindow\(/, ['apps/desktop/src/main/window.ts'])).toEqual([]);
  });

  it('disables DevTools and the menu in packaged builds', () => {
    const window = readFileSync(join(repo, 'apps/desktop/src/main/window.ts'), 'utf8');
    const main = readFileSync(join(repo, 'apps/desktop/src/main/index.ts'), 'utf8');
    expect(window).toContain('devTools: options.allowDevTools');
    expect(main).toMatch(/allowDevTools: !app\.isPackaged/);
    expect(main).toMatch(/if \(app\.isPackaged\) Menu\.setApplicationMenu\(null\)/);
  });

  it('ships the Electron fuses that block Node.js entry points', () => {
    const config = readFileSync(join(repo, 'apps/desktop/electron-builder.yml'), 'utf8');
    for (const fuse of [
      'runAsNode: false',
      'enableNodeOptionsEnvironmentVariable: false',
      'enableNodeCliInspectArguments: false',
      'enableEmbeddedAsarIntegrityValidation: true',
      'onlyLoadAppFromAsar: true',
    ]) {
      expect(config).toContain(fuse);
    }
    expect(config).toMatch(/requestedExecutionLevel: asInvoker/);
    expect(config).toMatch(/deleteAppDataOnUninstall: false/);
    expect(config).toMatch(/npmRebuild: false/);
  });
});
