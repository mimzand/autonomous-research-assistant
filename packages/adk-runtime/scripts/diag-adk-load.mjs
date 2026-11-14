#!/usr/bin/env node
/*
 * ADK module-load diagnostic (phase 7.2.1).   pnpm diag:adk-load
 *
 * Measures how long Node takes to load @google/adk and its dependency graph in
 * an unbundled checkout (the setup Vitest and the benchmark use), and how many
 * module files that is. It only IMPORTS the package: it calls no ADK API,
 * starts no agent, contacts no server and runs no model.
 *
 * Reported:
 * - wallMs: time of `await import('@google/adk')` in a fresh process;
 * - cpuMs / cpuShare: this process's CPU time during the import. A low share
 *   means the time was spent waiting (disk, antivirus scanning, file-system
 *   filters), not running JavaScript;
 * - modules: files loaded (ESM through a load hook, plus CommonJS from
 *   require.cache) and the average wall time per file;
 * - secondImportMs: importing again in the same process (cached; steady state).
 *
 * Run it twice in a row: the first run is "cold" (files not yet in the OS file
 * cache or the antivirus cache), the second "warm".
 *
 * The environment is sanitised exactly like loadAdkRuntime() does before ADK is
 * evaluated (telemetry endpoints and Google Cloud credentials removed,
 * OTEL_SDK_DISABLED=true), so importing it here cannot export telemetry.
 */
import { createRequire, register } from 'node:module';
import { MessageChannel } from 'node:worker_threads';

// Same lists as src/env.ts (sanitizeAdkEnvironment).
for (const name of [
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
  'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
  'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_GENAI_API_KEY',
  'GOOGLE_GENAI_USE_VERTEXAI',
  'GOOGLE_GENAI_USE_ENTERPRISE',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_LOCATION',
  'GOOGLE_CLOUD_AGENT_ENGINE_ID',
  'GOOGLE_APPLICATION_CREDENTIALS',
]) {
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- names come from the fixed list above
  delete process.env[name];
}
for (const name of Object.keys(process.env)) {
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- ADK feature flags, as in src/env.ts
  if (/^ADK_(ENABLE|DISABLE)_[A-Z0-9_]+$/.test(name)) delete process.env[name];
}
process.env.OTEL_SDK_DISABLED = 'true';
process.env.ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS = 'false';

// Count ESM files as Node loads them (the hook runs on Node's loader thread).
const { port1, port2 } = new MessageChannel();
let esmFiles = 0;
port1.on('message', () => esmFiles++);
const hook = `let port;
export async function initialize(data) { port = data.port; }
export async function load(url, context, next) {
  const result = await next(url, context);
  if (url.startsWith('file:')) port.postMessage(1);
  return result;
}`;
register(`data:text/javascript,${encodeURIComponent(hook)}`, {
  data: { port: port2 },
  transferList: [port2],
});
const require = createRequire(import.meta.url);
const cjsBefore = Object.keys(require.cache).length;
const esmBefore = esmFiles;

const cpu0 = process.cpuUsage();
const t0 = performance.now();
await import('@google/adk');
const wallMs = performance.now() - t0;
const cpu = process.cpuUsage(cpu0);

const t1 = performance.now();
await import('@google/adk');
const secondImportMs = performance.now() - t1;

await new Promise((resolve) => setTimeout(resolve, 200)); // let the hook's messages arrive
port1.close();

const cpuMs = (cpu.user + cpu.system) / 1000;
const modules = esmFiles - esmBefore + (Object.keys(require.cache).length - cjsBefore);
const round = (x) => Math.round(x * 10) / 10;
console.log(
  JSON.stringify(
    {
      node: process.version,
      platform: process.platform,
      wallMs: round(wallMs),
      cpuMs: round(cpuMs),
      cpuShare: round(cpuMs / wallMs),
      modules,
      msPerModule: modules > 0 ? round(wallMs / modules) : null,
      secondImportMs: round(secondImportMs),
    },
    null,
    2,
  ),
);
