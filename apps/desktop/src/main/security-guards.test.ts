/**
 * Architecture guards for the agent and main process. These scan the source
 * so that a forbidden capability cannot be added without a failing test:
 * - no shell / process execution anywhere in shipped code, except the one spawn
 *   allow-list (Phase 8): Electron starts the bundled agent with utilityProcess,
 *   only from agent-supervisor.ts, with a fixed entry and fixed arguments,
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
  'apps/agent/src',
  'apps/desktop/src',
  'packages/adk-runtime/src',
  'packages/agent-client/src',
  'packages/agent-host/src',
  'packages/agent-protocol/src',
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

  it('never executes shell commands or processes, except the supervised agent (Phase 8)', () => {
    // Nothing anywhere runs a shell or a child process through Node.
    expect(
      offenders(
        /child_process|\bexecSync\b|\bexecFile\b|\bspawn\s*\(|process\.binding|worker_threads/,
      ),
    ).toEqual([]);
    // The spawn allow-list: only the supervisor forks, and only Electron main hands it
    // utilityProcess. The agent and every package (tools included) start nothing.
    expect(
      offenders(/\bfork\s*\(|utilityProcess/, [
        'apps/desktop/src/main/agent-supervisor.ts',
        'apps/desktop/src/main/index.ts',
      ]),
    ).toEqual([]);
    const index = readFileSync(join(repo, 'apps/desktop/src/main/index.ts'), 'utf8');
    expect(index.match(/\bfork\s*\([^)]*\)/g)).toEqual(['fork(modulePath, args, options)']);
    expect(index).toContain(
      'fork: (modulePath, args, options) => utilityProcess.fork(modulePath, args, options),',
    );
    expect(index.match(/utilityProcess\.\w+/g)).toEqual(['utilityProcess.fork']);
    // The supervisor starts exactly one module, the bundled agent under the app path,
    // with fixed arguments built from Electron's own paths; no shell, no token in argv.
    const supervisor = readFileSync(
      join(repo, 'apps/desktop/src/main/agent-supervisor.ts'),
      'utf8',
    );
    expect(supervisor).not.toMatch(/from 'electron'/);
    expect(supervisor.match(/\bfork\(/g)).toHaveLength(1);
    expect(supervisor).toContain('const entry = agentEntryPath(deps.appPath);');
    expect(supervisor).toMatch(
      /deps\.fork\(entry, agentLaunchArgs\(\{ dataDir: deps\.dataDir, stateFile \}\), \{/,
    );
    expect(supervisor).toContain("return join(appPath, 'out', 'agent', 'main.js');");
    expect(supervisor).toContain(
      "return ['--data-dir', paths.dataDir, '--state-file', paths.stateFile, '--port', '0'];",
    );
    expect(supervisor).not.toMatch(/\btoken\s*:/);
  });

  it('never downloads, creates or deletes Ollama models', () => {
    expect(offenders(/\/api\/(pull|push|create|delete|copy|blobs)\b/)).toEqual([]);
  });

  it('deletes no files except the backup temporary file', () => {
    expect(
      offenders(/\b(rmSync|unlinkSync|rmdirSync|unlink|rmdir)\s*\(|fs\.rm\(|\.rm\(/, [
        'packages/storage/src/inspect.ts',
        'apps/desktop/src/bench/runner.ts',
        'apps/agent/src/state-file.ts',
        'apps/desktop/src/main/agent-supervisor.ts',
      ]),
    ).toEqual([]);
    // The supervisor removes only its agent's state file in the app's data folder.
    const supervisor = readFileSync(
      join(repo, 'apps/desktop/src/main/agent-supervisor.ts'),
      'utf8',
    );
    expect(supervisor.match(/rmSync\(([^,)]+)/g)).toEqual(['rmSync(stateFile']);
    expect(supervisor).toContain('const stateFile = join(deps.dataDir, AGENT_STATE_FILE_NAME);');
    // The agent removes only its own connection state file, and only while it still
    // holds this run's token.
    const agentState = readFileSync(join(repo, 'apps/agent/src/state-file.ts'), 'utf8');
    expect(agentState.match(/rmSync\(([^,)]+)/g)).toEqual(['rmSync(path']);
    expect(agentState).toMatch(
      /if \(current\.status !== 'ok' \|\| !tokensEqual\(current\.state\.token, token\)\) return false;\s*rmSync\(path, \{ force: true \}\);/,
    );
    // The benchmark (dev tooling, not part of the app) removes only the temporary
    // directories it created with mkdtempSync in the OS temp folder.
    const bench = readFileSync(join(repo, 'apps/desktop/src/bench/runner.ts'), 'utf8');
    expect(bench.match(/rmSync\(([^,)]+)/g)).toEqual(['rmSync(root', 'rmSync(dir']);
    expect(bench).toMatch(/const root = mkdtempSync\(join\(tmpdir\(\), 'rka-bench-'\)\)/);
    expect(bench).toMatch(/const dir = mkdtempSync\(join\(root, 'task-'\)\)/);
    // inspect.ts removes only its own `<target>.partial-*` file after a failed backup.
    const inspect = readFileSync(join(repo, 'packages/storage/src/inspect.ts'), 'utf8');
    expect(inspect.match(/rmSync\(([^,)]+)/g)).toEqual(['rmSync(temp']);
  });

  it('never ships the benchmark: no app code imports src/bench', () => {
    const app = files.filter((f) => !rel(f).startsWith('apps/desktop/src/bench/'));
    expect(
      app.filter((f) => /from '[^']*\/bench\//.test(readFileSync(f, 'utf8'))).map(rel),
    ).toEqual([]);
  });

  it('keeps model tool calling off except for the one gated Legacy Chat web-search path', () => {
    // Phase 8.2: the only provider that accepts tool calls is created by
    // OllamaProvider.withToolCalling() (the only place that sets allowToolCalls),
    // and only the Legacy Chat engine wiring asks for one. The shared provider,
    // Research and ADK never get tool calling, and the test harness that
    // executes tools is never imported by shipped code.
    expect(
      offenders(/\ballowToolCalls\s*:/, ['packages/model-provider/src/ollama/provider.ts']),
    ).toEqual([]);
    const provider = readFileSync(
      join(repo, 'packages/model-provider/src/ollama/provider.ts'),
      'utf8',
    );
    expect(provider.match(/\ballowToolCalls\s*:/g)).toHaveLength(1);
    expect(provider).toMatch(
      /withToolCalling\(\): OllamaProvider \{\s*return new OllamaProvider\(this\.config, \{ \.\.\.this\.options, allowToolCalls: true \}\);/,
    );
    expect(offenders(/\.withToolCalling\(\)/, ['packages/agent-host/src/chat-engine.ts'])).toEqual(
      [],
    );
    const main = readFileSync(join(repo, 'apps/desktop/src/main/index.ts'), 'utf8');
    expect(main).not.toMatch(/allowToolCalls|withToolCalling/);
    expect(offenders(/testing\/tool-harness/)).toEqual([]);
    const entry = readFileSync(join(repo, 'packages/model-provider/src/index.ts'), 'utf8');
    expect(entry).not.toMatch(/from '\.\/testing\//);
  });

  it('routes every model-driven tool call through the ToolGateway (Phase 8.2)', () => {
    // The tool loop is used only by the Legacy Chat engine; it never executes a
    // tool itself, it only asks the gateway.
    expect(
      offenders(/\bstreamChatWithTools\b/, [
        'packages/agent-runtime/src/chat/tool-chat.ts',
        'packages/agent-runtime/src/index.ts',
        'packages/agent-host/src/chat-engine.ts',
      ]),
    ).toEqual([]);
    const loop = readFileSync(join(repo, 'packages/agent-runtime/src/chat/tool-chat.ts'), 'utf8');
    expect(loop).not.toMatch(/\.execute\(|ToolRegistry|registry/);
    // Registry execution only from: the gateway (model-driven), the code-controlled
    // Research workflow, the user-driven Research Tools page, and the (unused) ADK bridge.
    expect(
      offenders(/\b(?:tools|registry)\.execute\(/, [
        'packages/agent-runtime/src/tools/gateway.ts',
        'packages/agent-runtime/src/research/workflow.ts',
        'packages/agent-host/src/research-tools.ts',
        'packages/adk-runtime/src/tools/registry-tool.ts',
      ]),
    ).toEqual([]);
    // Research (Legacy and ADK) never uses the gateway or the tool loop.
    const research = files.filter((f) =>
      /packages\/(agent|adk)-runtime\/src\/research\//.test(rel(f)),
    );
    expect(research.length).toBeGreaterThan(0);
    for (const file of research) {
      expect(readFileSync(file, 'utf8'), rel(file)).not.toMatch(
        /tools\/gateway|chat\/tool-chat|createToolGateway|streamChatWithTools|withToolCalling/,
      );
    }
    // The gateway can offer web_search only, and never passes an approval or task id.
    const gateway = readFileSync(join(repo, 'packages/agent-runtime/src/tools/gateway.ts'), 'utf8');
    expect(gateway).toMatch(
      /MODEL_EXPOSABLE_TOOLS: readonly string\[\] = Object\.freeze\(\['web_search'\]\)/,
    );
    expect(gateway).not.toMatch(/approvalId\s*:|taskId\s*:/);
  });

  it('never evaluates dynamic code', () => {
    expect(offenders(/\beval\s*\(|new\s+Function\s*\(|vm\.run/)).toEqual([]);
  });

  it('opens external links only from the checked call sites', () => {
    expect(
      offenders(/openExternal\s*\(|openPath\s*\(|showItemInFolder\s*\(/, [
        'apps/desktop/src/main/host-ports.ts',
        // Service mode: delegates to the host-ports implementation above.
        'apps/desktop/src/main/service-shell-ports.ts',
        'apps/desktop/src/main/window.ts',
        'packages/agent-host/src/research-tools.ts',
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

describe('Windows packaging configuration (Phase 7.7)', () => {
  const config = readFileSync(join(repo, 'apps/desktop/electron-builder.yml'), 'utf8');
  const pkg = JSON.parse(readFileSync(join(repo, 'apps/desktop/package.json'), 'utf8')) as {
    productName: string;
    dependencies: Record<string, string>;
  };

  /** The items of every `files:` list (top level and per platform). */
  function fileLists(): string[][] {
    const lines = config.split(/\r?\n/);
    const lists: string[][] = [];
    lines.forEach((line, i) => {
      const m = /^(\s*)files:\s*$/.exec(line);
      if (!m) return;
      const items: string[] = [];
      for (const next of lines.slice(i + 1)) {
        const item = /^\s*-\s*'?([^']*)'?\s*$/.exec(next);
        if (item?.[1] !== undefined) items.push(item[1]);
        else if (next.trim() && !next.trim().startsWith('#')) break;
      }
      lists.push(items);
    });
    return lists;
  }

  it('every files list includes the build explicitly (an only-"!" list would ship the whole app folder)', () => {
    const lists = fileLists();
    expect(lists.length).toBeGreaterThanOrEqual(3); // top level, win, linux
    for (const items of lists) {
      expect(items, JSON.stringify(items)).toContain('out/**/*');
      expect(items).toContain('package.json');
      expect(
        items.every((i) => i.startsWith('!') || ['out/**/*', 'package.json'].includes(i)),
      ).toBe(true);
    }
  });

  it('keeps the identity that decides the data folder and the upgrade path', () => {
    expect(config).toMatch(/^appId: com\.rka\.autonomous-research-assistant$/m);
    expect(config).toMatch(/^productName: Autonomous Research Assistant$/m);
    expect(pkg.productName).toBe('Autonomous Research Assistant');
    expect(config).toMatch(/^ {2}executableName: Autonomous Research Assistant$/m);
  });

  it('per-user NSIS installer, x64, no elevation, keeps user data, no auto-update, no signing secrets', () => {
    for (const line of [
      'perMachine: false',
      'allowElevation: false',
      'deleteAppDataOnUninstall: false',
      'target: nsis',
      'arch: [x64]',
      'publish: null',
    ]) {
      expect(config).toContain(line);
    }
    expect(config).not.toMatch(/CSC_LINK\s*:|certificatePassword|certificateFile/);
  });

  it('ships one runtime dependency, unpacked from the asar, without build-only files', () => {
    expect(Object.keys(pkg.dependencies)).toEqual(['better-sqlite3']);
    expect(config).toContain("- '**/node_modules/better-sqlite3/**/*.node'");
    expect(config).toContain("- '!**/node_modules/node-addon-api/**'");
    expect(config).toMatch(/^asar: true$/m);
  });

  it('Chromium downloads no spell-check dictionaries (no runtime request to Google)', () => {
    const main = readFileSync(join(repo, 'apps/desktop/src/main/index.ts'), 'utf8');
    expect(main).toContain('session.defaultSession.setSpellCheckerEnabled(false);');
    expect(main).toContain('session.defaultSession.setSpellCheckerLanguages([]);');
    const window = readFileSync(join(repo, 'apps/desktop/src/main/window.ts'), 'utf8');
    expect(window).toContain('spellcheck: false');
  });

  it('loads the renderer from the package in production (dev server URL only when not packaged)', () => {
    const main = readFileSync(join(repo, 'apps/desktop/src/main/index.ts'), 'utf8');
    expect(main).toMatch(
      /const devServerUrl = app\.isPackaged \? undefined : process\.env\['ELECTRON_RENDERER_URL'\];/,
    );
    const window = readFileSync(join(repo, 'apps/desktop/src/main/window.ts'), 'utf8');
    expect(window).toMatch(/loadFile\(rendererIndexPath\(\)\)/);
  });
});
