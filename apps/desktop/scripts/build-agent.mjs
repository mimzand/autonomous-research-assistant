#!/usr/bin/env node
/*
 * Builds the agent service for the desktop app (Agent Process Separation Phase 8):
 * apps/agent/src/main.ts → apps/desktop/out/agent/main.js, an ES module that
 * Electron starts with utilityProcess.fork (src/main/agent-supervisor.ts).
 *
 * Everything is bundled (workspace packages, Zod, Drizzle, Google ADK as a lazy
 * chunk) except better-sqlite3, the one native addon: it is loaded from the app's
 * node_modules (app.asar, binary in app.asar.unpacked), exactly like the main
 * bundle loads it. Its prebuilt binary uses Node-API, so the same file loads in
 * Electron's main process, its utility process and plain Node.
 *
 * Run by `pnpm build`, `pnpm dev` and the package scripts; `pnpm agent:dev` does
 * not need it (tsx runs the sources).
 */
import { builtinModules } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const AGENT_ENTRY = resolve(appRoot, '../agent/src/main.ts');
export const AGENT_OUT_DIR = resolve(appRoot, 'out/agent');

const external = new Set([
  'better-sqlite3',
  'electron', // never used by the agent; listed so an accidental import fails loudly at run time
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);

await build({
  configFile: false,
  logLevel: 'warn',
  root: appRoot,
  mode: 'production',
  ssr: { noExternal: true, target: 'node' },
  build: {
    ssr: AGENT_ENTRY,
    outDir: AGENT_OUT_DIR,
    emptyOutDir: true,
    target: 'node22',
    sourcemap: false,
    minify: false,
    copyPublicDir: false,
    rollupOptions: {
      external: (id) => external.has(id),
      output: {
        format: 'es',
        entryFileNames: 'main.js',
        chunkFileNames: 'chunks/[name]-[hash].js',
      },
    },
  },
});
console.info(`Agent service built: ${AGENT_OUT_DIR}/main.js`);
