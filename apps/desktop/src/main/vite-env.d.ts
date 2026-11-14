/**
 * Build-time constants electron-vite defines for the main process. `DEV` is true
 * only under `electron-vite dev`; a production build replaces it with `false`
 * and drops the code behind it (the in-process development path).
 */
interface ImportMetaEnv {
  readonly DEV: boolean;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
