#!/usr/bin/env node
/*
 * Packaged-app acceptance (Phase 7.7). Runs the BUILT application, not the dev
 * server:
 *
 *   pnpm package:dir            (or pnpm package:win on Windows)
 *   pnpm smoke:packaged [path to the unpacked app folder] [--keep]
 *   pnpm smoke:packaged release/win-unpacked --target=win32-x64 --static-only
 *
 * Default folder: apps/desktop/release/win-unpacked (Windows) or linux-unpacked.
 * --target checks a package built for another OS (static checks only, e.g. a
 * Windows zip cross-built on Linux); --keep keeps the temporary user-data folder.
 *
 * 1. Static checks of the package: app.asar layout, nothing from development
 *    (sources, maps, tests, .env), only better-sqlite3 unpacked with the native
 *    binary for this OS, ADK bundled, production CSP, no credentials or company
 *    endpoints.
 * 2. Runtime checks: starts the executable with an ISOLATED, temporary user-data
 *    folder (--user-data-dir) and a fake Ollama + fake SearXNG on 127.0.0.1, then
 *    drives the real preload API over the Chromium DevTools protocol
 *    (--remote-debugging-port; the fuses disable Node's --inspect, not this).
 *    Covers: renderer from file:// (no dev server), isolation, CSP, SQLite in the
 *    user-data folder, Settings IPC and persistence, environment overrides,
 *    Legacy and ADK Chat, Research task creation with the ADK engine pinned,
 *    a forced kill and recovery on restart, and a clean quit.
 *
 * It never touches the real user profile (%APPDATA%\Autonomous Research
 * Assistant), never contacts the internet or a real Ollama, and runs no model.
 * The temporary folder is removed at the end unless --keep is given.
 */
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const args = process.argv.slice(2);
const keep = args.includes('--keep');
const targetArg = args.find((a) => a.startsWith('--target='))?.slice('--target='.length);
const [targetOs, targetArch] = (targetArg ?? `${process.platform}-${process.arch}`).split('-');
const staticOnly = args.includes('--static-only') || targetOs !== process.platform;
const isWin = targetOs === 'win32';
const unpacked = resolve(
  args.find((a) => !a.startsWith('--')) ??
    join(appRoot, 'release', isWin ? 'win-unpacked' : 'linux-unpacked'),
);
const exe = join(
  unpacked,
  isWin ? 'Autonomous Research Assistant.exe' : 'autonomous-research-assistant',
);
const resources = join(unpacked, 'resources');
const MODEL = 'qwen3:8b';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

// --- 1. Static checks ------------------------------------------------------------------------

/** Minimal asar reader: header JSON and file contents (Electron's documented format). */
function readAsar(path) {
  const buffer = readFileSync(path);
  const jsonSize = buffer.readUInt32LE(12);
  const header = JSON.parse(buffer.subarray(16, 16 + jsonSize).toString('utf8'));
  const base = 8 + buffer.readUInt32LE(4);
  const files = new Map();
  const walk = (node, prefix) => {
    for (const [name, entry] of Object.entries(node.files ?? {})) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (entry.files) walk(entry, path);
      else files.set(path, entry);
    }
  };
  walk(header, '');
  const read = (path) => {
    const entry = files.get(path);
    if (!entry || entry.unpacked) return null;
    const start = base + Number(entry.offset);
    return buffer.subarray(start, start + entry.size).toString('utf8');
  };
  return { files, read, size: buffer.length };
}

function listFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? listFiles(join(dir, e.name)) : [join(dir, e.name)],
  );
}

function dirSize(dir) {
  return listFiles(dir).reduce((sum, f) => sum + statSync(f).size, 0);
}
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

function staticChecks() {
  check('unpacked app folder exists', existsSync(exe), exe);
  if (!existsSync(exe)) return false;
  const asarPath = join(resources, 'app.asar');
  check('resources/app.asar exists', existsSync(asarPath));
  check(
    'no loose resources/app folder (code only from the asar)',
    !existsSync(join(resources, 'app')),
  );
  const asar = readAsar(asarPath);
  const names = [...asar.files.keys()];
  for (const required of [
    'package.json',
    'out/main/index.js',
    'out/preload/index.cjs',
    'out/renderer/index.html',
  ]) {
    check(`asar contains ${required}`, asar.files.has(required));
  }
  const dev = names.filter(
    (n) =>
      /\.map$/.test(n) ||
      /(^|\/)src\//.test(n) ||
      (/\.ts$/.test(n) && !/\.d\.ts$/.test(n)) ||
      /\.(test|spec)\.[cm]?[jt]s$/.test(n) ||
      /test-fixtures/.test(n) ||
      /(^|\/)\.env/.test(n) ||
      /(^|\/)(release|bench|docs|scripts)\//.test(n),
  );
  check(
    'no sources, maps, tests, .env, bench or scripts in the asar',
    dev.length === 0,
    dev.slice(0, 5).join(', '),
  );
  const pkg = JSON.parse(asar.read('package.json') ?? '{}');
  check('package.json main is the built entry', pkg.main === './out/main/index.js', pkg.main);
  check(
    'only runtime dependency is better-sqlite3',
    JSON.stringify(Object.keys(pkg.dependencies ?? {})) === '["better-sqlite3"]',
    Object.keys(pkg.dependencies ?? {}).join(', '),
  );
  const html = asar.read('out/renderer/index.html') ?? '';
  check("production CSP (connect-src 'none') in the renderer", html.includes("connect-src 'none'"));
  check(
    'renderer loads no remote or dev-server URL',
    !/https?:\/\/(localhost|127\.0\.0\.1)/.test(html),
  );
  const chunks = names.filter((n) => n.startsWith('out/main/'));
  const adk = chunks.find((n) => (asar.read(n) ?? '').includes('ADK_VERSION'));
  check('Google ADK is bundled (lazy engine chunk)', Boolean(adk), adk ?? 'not found');

  // Credentials and company endpoints must never ship.
  const texts = names
    .filter((n) => /\.(js|cjs|mjs|json|html|css)$/.test(n))
    .map((n) => [n, asar.read(n) ?? '']);
  const secretPatterns = [
    /ngrok-free\.dev/i,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /\bsk-[A-Za-z0-9]{20,}/,
    /\bghp_[A-Za-z0-9]{30,}/,
    /CSC_KEY_PASSWORD\s*[=:]\s*\S/,
  ];
  const leaks = texts.flatMap(([n, t]) =>
    secretPatterns.filter((p) => p.test(t)).map((p) => `${n}: ${p}`),
  );
  check(
    'no credentials, keys or tunnel endpoints in the package',
    leaks.length === 0,
    leaks.join('; '),
  );

  // Native addon: only better-sqlite3, with the binary for this OS/arch.
  const unpackedFiles = listFiles(join(resources, 'app.asar.unpacked')).map((f) =>
    relative(join(resources, 'app.asar.unpacked'), f).split(sep).join('/'),
  );
  check(
    'app.asar.unpacked holds only better-sqlite3',
    unpackedFiles.length > 0 &&
      unpackedFiles.every((f) => f.startsWith('node_modules/better-sqlite3/')),
  );
  const nodes = unpackedFiles.filter((f) => f.endsWith('.node'));
  const wanted = `${targetOs}-${targetArch}.node`;
  check(
    `native SQLite binary for ${targetOs}-${targetArch} present`,
    nodes.some((f) => f.endsWith(wanted)),
    nodes.join(', '),
  );
  const foreign = nodes.filter((f) => !f.includes(`/prebuilds/${targetOs}-`));
  check('no native binaries for other operating systems', foreign.length === 0, foreign.join(', '));

  console.log(
    `INFO  sizes: app.asar ${mb(asar.size)}, app.asar.unpacked ${mb(dirSize(join(resources, 'app.asar.unpacked')))}, unpacked folder ${mb(dirSize(unpacked))}`,
  );
  return true;
}

// --- 2. Fake services ------------------------------------------------------------------------

const ollamaLog = [];
const holdPlan = { on: true, waiting: [] };
const json = (res, value, status = 200) =>
  void res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
const ollama = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {};
    const user = (body.messages ?? []).find((m) => m.role === 'user')?.content ?? '';
    const task = /^Task: ([a-z-]+)/m.exec(user)?.[1] ?? null;
    ollamaLog.push({ method: req.method, url: req.url, task, stream: body.stream === true });
    if (req.url === '/api/version') return json(res, { version: '0.40.14' });
    if (req.url === '/api/tags')
      return json(res, {
        models: [{ name: MODEL, model: MODEL, size: 5_000_000_000, details: {} }],
      });
    if (req.url === '/api/show')
      return json(res, { capabilities: ['completion', 'tools'], model_info: {}, details: {} });
    if (req.url !== '/api/chat') return json(res, { error: 'not found' }, 404);
    if (task === 'create-plan' && holdPlan.on) {
      holdPlan.waiting.push(res); // the task stays "running" at its first step
      return;
    }
    const line = (content, done) =>
      JSON.stringify({
        model: MODEL,
        created_at: '2026-11-13T10:00:00Z',
        message: { role: 'assistant', content },
        done,
        ...(done && {
          done_reason: 'stop',
          prompt_eval_count: 5,
          eval_count: 2,
          total_duration: 1000,
        }),
      });
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.end(`${line('O', false)}\n${line('K', false)}\n${line('', true)}\n`);
    } else {
      json(res, JSON.parse(line('{}', true)));
    }
  });
});
const searxng = createServer((req, res) =>
  json(res, { query: 'q', results: [], unresponsive_engines: [] }),
);
const listen = (server) =>
  new Promise((done) => server.listen(0, '127.0.0.1', () => done(server.address().port)));

// --- 3. Launch and drive the packaged app ------------------------------------------------------

let ollamaPort = 0;
let searxPort = 0;

let launches = 0;
function launch(userData, { hostile = false } = {}) {
  launches += 1;
  // A killed run leaves its DevToolsActivePort behind (temporary test profile only).
  rmSync(join(userData, 'DevToolsActivePort'), { force: true });
  // The user's own Ollama/engine/web variables must not leak into the test.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^(OLLAMA_|SEARXNG_|WEB_|RESEARCH_|AGENT_ENGINE|ELECTRON_)/.test(key),
    ),
  );
  Object.assign(env, {
    OLLAMA_HOST: `127.0.0.1:${ollamaPort}`,
    OLLAMA_MODEL: MODEL,
    SEARXNG_URL: `http://127.0.0.1:${searxPort}`,
  });
  const argv = [
    `--user-data-dir=${userData}`,
    '--remote-debugging-port=0',
    // Chromium's own network log: proves the app makes no requests beyond the fakes.
    `--log-net-log=${join(userData, `net-${launches}.json`)}`,
  ];
  if (hostile) {
    // Must have no effect: the fuses disable RunAsNode and Node's inspector.
    env.ELECTRON_RUN_AS_NODE = '1';
    argv.push('--inspect=0');
  }
  // Chromium refuses to run its sandbox as root (CI containers only).
  if (process.getuid?.() === 0) argv.push('--no-sandbox');
  const child = spawn(exe, argv, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = { stdout: '', stderr: '' };
  child.stdout.on('data', (c) => (out.stdout += c));
  child.stderr.on('data', (c) => (out.stderr += c));
  const exited = new Promise((done) => child.on('exit', (code, signal) => done({ code, signal })));
  return { child, out, exited, userData };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 30_000) {
  const end = Date.now() + ms;
  for (;;) {
    // A failed probe (e.g. the page is still loading) counts as "not yet".
    const value = await Promise.resolve()
      .then(fn)
      .catch(() => undefined);
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

/** Minimal Chrome DevTools Protocol client for the renderer page (Node 22 WebSocket). */
async function connect(app) {
  // From stderr, or (Windows GUI processes may not write it there) from the
  // DevToolsActivePort file Chromium writes into this run's profile (removed before
  // each launch, so it is never a stale port from a killed run).
  const portFile = join(app.userData, 'DevToolsActivePort');
  const port = await until(
    () =>
      /DevTools listening on ws:\/\/[^:]+:(\d+)\//.exec(app.out.stderr)?.[1] ??
      (existsSync(portFile) ? readFileSync(portFile, 'utf8').split(/\r?\n/)[0]?.trim() : undefined),
    'the DevTools port',
  );
  const page = await until(async () => {
    const list = await fetch(`http://127.0.0.1:${port}/json/list`).then(
      (r) => r.json(),
      () => [],
    );
    // Wait for the packaged renderer, not the initial about:blank.
    return list.find((t) => t.type === 'page' && t.url.startsWith('file://'));
  }, 'the renderer page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((done, fail) => {
    ws.onopen = done;
    ws.onerror = fail;
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
  };
  /** Every call has a deadline: a call made while the page navigates may get no answer. */
  const send = (method, params = {}, ms = 20_000) =>
    new Promise((done, fail) => {
      id += 1;
      const callId = id;
      const timer = setTimeout(() => {
        pending.delete(callId);
        fail(new Error(`DevTools call ${method} timed out`));
      }, ms);
      pending.set(callId, (msg) => {
        clearTimeout(timer);
        done(msg);
      });
      ws.send(JSON.stringify({ id: callId, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.result?.exceptionDetails)
      throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 500));
    return r.result?.result?.value;
  };
  await until(
    () =>
      Promise.race([
        evaluate('document.readyState === "complete" && typeof window.api === "object"'),
        sleep(2000).then(() => false),
      ]),
    'window.api',
  );
  return { url: page.url, evaluate, close: () => ws.close(), port };
}

/** A normal quit, like closing the window: the app's will-quit handler closes SQLite. */
async function quit(app, session) {
  await session.evaluate('window.close(), true').catch(() => undefined);
  const result = await Promise.race([app.exited, sleep(15_000).then(() => null)]);
  if (!result) {
    app.child.kill('SIGKILL');
    return { forced: true };
  }
  return result;
}

const chatOnce = `(async () => {
  const events = [];
  const off = window.api.chat.onEvent((e) => events.push(e));
  const started = await window.api.chat.start({ messages: [{ role: 'user', content: 'Reply with OK.' }] });
  for (let i = 0; i < 300 && !events.some((e) => ['done', 'error', 'cancelled'].includes(e.type)); i++)
    await new Promise((r) => setTimeout(r, 50));
  off();
  return { started, text: events.filter((e) => e.type === 'delta').map((e) => e.content).join(''), last: events.at(-1) };
})()`;

async function runtimeChecks() {
  ollamaPort = await listen(ollama);
  searxPort = await listen(searxng);
  const userData = mkdtempSync(join(tmpdir(), 'rka-packaged-smoke-'));
  const dbFile = join(userData, 'data', 'research.db');
  console.log(`INFO  isolated user data: ${userData}`);
  // settings.env with keys the app must ignore (only OLLAMA_*, SEARXNG_*, WEB_*,
  // RESEARCH_* and AGENT_ENGINE are applied).
  writeFileSync(
    join(userData, 'settings.env'),
    'NODE_OPTIONS=--require=./does-not-exist.js\nRKA_UNKNOWN_KEY=1\n',
  );
  let taskId;
  try {
    // --- First start (with ELECTRON_RUN_AS_NODE=1 and --inspect, which must do nothing) ---------
    let app = launch(userData, { hostile: true });
    let s = await connect(app);
    check(
      'fuses: ELECTRON_RUN_AS_NODE and --inspect have no effect',
      !/Debugger listening/.test(app.out.stderr),
    );
    check(
      'settings.env: NODE_OPTIONS and unknown keys are ignored (and reported)',
      /Ignored unsupported keys in .*settings\.env: .*NODE_OPTIONS/.test(
        app.out.stdout + app.out.stderr,
      ),
    );
    check(
      'renderer loaded from the package (file://), no dev server',
      s.url.startsWith('file://') && s.url.includes('app.asar'),
      s.url,
    );
    const isolation = await s.evaluate(
      'JSON.stringify([typeof require, typeof process, typeof module, Object.isFrozen(window.api)])',
    );
    check(
      'context isolation: no require/process/module in the page; frozen window.api',
      isolation === '["undefined","undefined","undefined",true]',
      isolation,
    );
    const blocked = await s.evaluate(
      `fetch('http://127.0.0.1:${ollamaPort}/api/version').then(() => 'reached', () => 'blocked')`,
    );
    check('CSP blocks network access from the renderer', blocked === 'blocked', blocked);
    const inline = await s.evaluate(
      "(() => { const el = document.createElement('script'); el.textContent = 'window.__rkaInline = 1'; document.head.append(el); return typeof window.__rkaInline; })()",
    );
    check('CSP blocks inline scripts', inline === 'undefined', inline);
    // Local targets only: if a lock were broken, the fake server would log the request.
    const away = `http://127.0.0.1:${ollamaPort}`;
    // A non-http URL: the app denies every new window, and hands http(s) links to the
    // system browser (shell.openExternal) by design. Probing with an http URL would open
    // a tab in the user's default browser.
    const popup = await s.evaluate("window.open('file:///') === null");
    check('window.open is denied (no in-app window)', popup === true);
    await s.evaluate(`(location.href = '${away}/navigated', true)`).catch(() => undefined);
    await sleep(500);
    const still = await s.evaluate('location.href');
    check(
      'navigation away from the app is blocked',
      String(still).startsWith('file://') && !ollamaLog.some((r) => r.url.includes('/navigated')),
      still,
    );
    check('SQLite database created in the user-data folder', existsSync(dbFile), dbFile);
    check('database is outside the application folder', !resolve(dbFile).startsWith(unpacked));

    const health = await s.evaluate('window.api.getModelHealth()');
    check(
      'model health over IPC: ready via the configured (fake) Ollama',
      health?.status === 'ready' && health.baseUrl === `http://127.0.0.1:${ollamaPort}`,
      `${health?.status} ${health?.baseUrl}`,
    );
    const view = await s.evaluate('window.api.settings.get()');
    check(
      'Settings IPC: OLLAMA_HOST/OLLAMA_MODEL shown as environment overrides',
      view?.entries?.['ollama.baseUrl']?.overridden === true &&
        view.entries['model.name']?.overridden === true,
    );
    check(
      'engines default to Legacy',
      view?.values?.['engine.chat'] === 'legacy' && view.values['engine.research'] === 'legacy',
    );

    const legacy = await s.evaluate(chatOnce);
    check(
      'Legacy Chat streams a reply',
      legacy?.last?.type === 'done' && legacy.text === 'OK',
      JSON.stringify(legacy?.last),
    );
    const saved = await s.evaluate(
      `window.api.settings.update({ 'engine.chat': 'adk', 'engine.research': 'adk' })`,
    );
    check(
      'Settings update saved (Chat and Research engine = ADK)',
      saved?.status === 'saved',
      saved?.status,
    );
    const adk = await s.evaluate(chatOnce);
    check(
      'ADK Chat streams a reply (ADK loads from the package)',
      adk?.last?.type === 'done' && adk.text === 'OK',
      JSON.stringify(adk?.last),
    );
    check('main process selected the ADK chat engine', /Chat engine: adk/.test(app.out.stdout));

    const started = await s.evaluate(
      `window.api.tasks.startResearch({ goal: 'Packaged smoke test: what is a lighthouse?' })`,
    );
    taskId = started?.taskId ?? null;
    check(
      'Research task created',
      started?.status === 'ok' && Boolean(taskId),
      JSON.stringify(started),
    );
    await until(
      () => ollamaLog.some((r) => r.task === 'create-plan'),
      'the first Research model call',
    );
    const running = await s.evaluate(`window.api.tasks.get(${JSON.stringify(taskId)})`);
    check(
      'Research task runs with the ADK engine pinned',
      running?.task?.status === 'running' && running.research?.engine === 'adk',
      `${running?.task?.status} ${running?.research?.engine}`,
    );

    // --- Forced kill while the task runs, then restart -------------------------------------------
    app.child.kill('SIGKILL');
    await app.exited;
    holdPlan.waiting.splice(0).forEach((r) => r.destroy());
    s.close();
    app = launch(userData);
    s = await connect(app);
    const recovered = await s.evaluate(`window.api.tasks.get(${JSON.stringify(taskId)})`);
    check(
      'after a forced kill: task recovered as interrupted (app closed), still pinned to ADK',
      recovered?.task?.status === 'interrupted' &&
        recovered.recovery?.interruption?.kind === 'app-closed' &&
        recovered.recovery?.resumable === true &&
        recovered.research?.engine === 'adk',
      `${recovered?.task?.status} ${recovered?.recovery?.interruption?.kind} ${recovered?.research?.engine}`,
    );
    const view2 = await s.evaluate('window.api.settings.get()');
    check(
      'saved Settings survive a restart',
      view2?.values?.['engine.chat'] === 'adk' && view2.entries['engine.chat']?.source === 'saved',
    );
    const integrity = await s.evaluate('window.api.storage.integrityCheck()');
    check(
      'database integrity check after the kill',
      JSON.stringify(integrity).includes('"ok":true'),
      JSON.stringify(integrity).slice(0, 120),
    );
    const cancelled = await s.evaluate(`window.api.tasks.cancel(${JSON.stringify(taskId)})`);
    check(
      'interrupted task can be cancelled',
      cancelled?.status === 'ok',
      JSON.stringify(cancelled),
    );

    // --- Normal quit and restart ------------------------------------------------------------------
    const exit = await quit(app, s);
    s.close();
    check('normal quit ends the app', !exit.forced, JSON.stringify(exit));
    app = launch(userData);
    s = await connect(app);
    const after = await s.evaluate(`window.api.tasks.get(${JSON.stringify(taskId)})`);
    check(
      'database reopens after a normal quit; task still cancelled',
      after?.task?.status === 'cancelled',
    );
    const walFiles = readdirSync(join(userData, 'data'));
    check(
      'SQLite files only in the user-data folder',
      walFiles.every((f) => f.startsWith('research.db')),
      walFiles.join(', '),
    );
    const dictionaries = join(userData, 'Dictionaries');
    check(
      'no spell-check dictionaries downloaded',
      !existsSync(dictionaries) || readdirSync(dictionaries).length === 0,
    );
    await quit(app, s);
    s.close();

    // Every request Chromium itself made in all runs (renderer, spellchecker, components).
    // The app's Ollama/SearXNG calls go through Node in the main process and are not in
    // this log; the fakes record those. A killed run's log is cut off: plain text scan.
    const logs = readdirSync(userData).filter((n) => /^net-\d+\.json$/.test(n));
    const hosts = new Set();
    for (const f of logs) {
      const log = readFileSync(join(userData, f), 'utf8');
      for (const m of log.matchAll(/(?:https?|wss?):\/\/([a-z0-9.-]+)/gi))
        hosts.add(m[1].toLowerCase());
    }
    const external = [...hosts].filter((h) => !['127.0.0.1', 'localhost'].includes(h));
    check(
      'Chromium makes no network requests (net log of every run)',
      logs.length === launches && external.length === 0,
      external.length ? external.join(', ') : `${logs.length} log(s), no external host`,
    );
    const paths = [...new Set(ollamaLog.map((r) => r.url))].sort();
    check(
      'Ollama received only read and chat calls (no pull/create/delete)',
      paths.every((p) => ['/api/chat', '/api/show', '/api/tags', '/api/version'].includes(p)),
      paths.join(', '),
    );
  } finally {
    ollama.closeAllConnections?.();
    ollama.close();
    searxng.close();
    if (!keep) rmSync(userData, { recursive: true, force: true });
  }
}

// --- main ----------------------------------------------------------------------------------------

try {
  if (staticChecks() && !staticOnly) await runtimeChecks();
  if (staticOnly) console.log('INFO  runtime checks skipped (--static-only or another target OS).');
} catch (error) {
  check('smoke test completed', false, error instanceof Error ? error.message : String(error));
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
process.exit(failed.length ? 1 : 0);
