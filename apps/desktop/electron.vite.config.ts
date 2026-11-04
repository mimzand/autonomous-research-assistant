import { resolve } from 'node:path';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'electron-vite';

/** Absolute paths: the renderer has its own `root`, so relative inputs resolve differently in dev and build. */
const fromHere = (path: string): string => resolve(import.meta.dirname, path);

/**
 * All runtime code (workspace packages, zod, vue) is bundled, which is why
 * the desktop app lists everything under devDependencies: the packaged app
 * needs no node_modules besides Electron itself.
 */
export default defineConfig({
  main: {
    build: {
      externalizeDeps: false,
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
