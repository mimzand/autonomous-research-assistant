import { resolve } from 'node:path';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'electron-vite';

/** Absolute paths: the renderer has its own `root`, so relative inputs resolve differently in dev and build. */
const fromHere = (path: string): string => resolve(import.meta.dirname, path);

/**
 * All runtime code (workspace packages, zod, drizzle, vue) is bundled, which is
 * why the desktop app lists almost everything under devDependencies. The one
 * runtime dependency is better-sqlite3: a native addon loaded from node_modules.
 */
export default defineConfig({
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
    plugins: [vue()],
    build: {
      outDir: fromHere('out/renderer'),
      rollupOptions: {
        input: { index: fromHere('src/renderer/index.html') },
      },
    },
  },
});
