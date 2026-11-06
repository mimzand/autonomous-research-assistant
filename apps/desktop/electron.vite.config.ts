import { createServer } from 'node:net';
import { resolve } from 'node:path';
import vue from '@vitejs/plugin-vue';
import { defineConfig, type UserConfig } from 'electron-vite';
import { type Plugin } from 'vite';

/** Absolute paths: the renderer has its own `root`, so relative inputs resolve differently in dev and build. */
const fromHere = (path: string): string => resolve(import.meta.dirname, path);

/**
 * All runtime code (workspace packages, zod, drizzle, vue) is bundled, which is
 * why the desktop app lists almost everything under devDependencies. The one
 * runtime dependency is better-sqlite3: a native addon loaded from node_modules.
 */
/**
 * Content-Security-Policy of the packaged renderer. Stricter than the one in
 * index.html, which must allow the dev server's injected <style> tags and HMR
 * socket. The renderer talks to the main process only through the preload
 * bridge, so it needs no network access at all (connect-src 'none').
 * style-src-attr allows style="" attributes (used by Vue bindings); they
 * cannot run script.
 */
export const PRODUCTION_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "style-src-attr 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "media-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "manifest-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const productionCsp = (): Plugin => ({
  name: 'rka-production-csp',
  apply: 'build',
  transformIndexHtml(html) {
    const pattern = /(http-equiv="Content-Security-Policy"\s+content=")[^"]*(")/;
    if (!pattern.test(html)) throw new Error('index.html has no Content-Security-Policy meta tag.');
    return html.replace(pattern, `$1${PRODUCTION_CSP}$2`);
  },
});

/**
 * Dev server address. IPv4 loopback, not "localhost" (on Windows that is ::1).
 * Hyper-V, WSL and Docker Desktop reserve port ranges on Windows; listening on a
 * reserved port fails with EACCES, which Vite does not retry. So in development
 * the first port that can actually be opened is used: RKA_DEV_PORT if set
 * (exactly that port), otherwise 5173 and then a few alternatives.
 */
export const DEV_HOST = '127.0.0.1';
export const DEV_PORT_CANDIDATES = [5173, 5273, 5373, 5473, 3173, 4173, 6173, 7173, 8173, 9173];

export function parseDevPort(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`RKA_DEV_PORT must be a port number between 1024 and 65535 (got "${value}").`);
  }
  return port;
}

/** Resolves with the error code when the port cannot be opened, or null when it can. */
export function probePort(port: number, host = DEV_HOST): Promise<string | null> {
  return new Promise((done) => {
    const server = createServer();
    server.once('error', (error: NodeJS.ErrnoException) => done(error.code ?? 'error'));
    server.listen({ port, host, exclusive: true }, () => server.close(() => done(null)));
  });
}

export async function pickDevPort(
  env: string | undefined = process.env['RKA_DEV_PORT'],
  probe: (port: number) => Promise<string | null> = probePort,
): Promise<number> {
  const fixed = parseDevPort(env);
  const candidates = fixed === undefined ? DEV_PORT_CANDIDATES : [fixed];
  const failures: string[] = [];
  for (const port of candidates) {
    const problem = await probe(port);
    if (problem === null) return port;
    failures.push(`${port} (${problem})`);
  }
  throw new Error(
    `No dev server port could be opened on ${DEV_HOST}: ${failures.join(', ')}. ` +
      'Windows may reserve these ports (see "netsh interface ipv4 show excludedportrange protocol=tcp"). ' +
      'Set RKA_DEV_PORT to a free port outside the reserved ranges.',
  );
}

export default defineConfig(async ({ command }): Promise<UserConfig> => ({
  main: {
    build: {
      // Externalizes only package.json `dependencies`: better-sqlite3 (native addon).
      externalizeDeps: true,
      outDir: fromHere('out/main'),
      rollupOptions: {
        input: { index: fromHere('src/main/index.ts') },
      },
    },
  },
  preload: {
    build: {
      // Sandboxed preload scripts must be a single CommonJS file.
      externalizeDeps: false,
      outDir: fromHere('out/preload'),
      rollupOptions: {
        input: { index: fromHere('src/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: fromHere('src/renderer'),
    plugins: [vue(), productionCsp()],
    server: {
      host: DEV_HOST,
      // Only probed when serving; builds need no port.
      port: command === 'serve' ? await pickDevPort() : DEV_PORT_CANDIDATES[0],
      // Fail with a clear message instead of silently moving to another port.
      strictPort: true,
    },
    build: {
      // No source maps in the shipped app.
      sourcemap: false,
      outDir: fromHere('out/renderer'),
      rollupOptions: {
        input: { index: fromHere('src/renderer/index.html') },
      },
    },
  },
}));
