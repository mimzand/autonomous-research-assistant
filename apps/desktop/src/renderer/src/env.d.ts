/// <reference types="vite/client" />

import { type RendererApi } from '@rka/shared';

declare global {
  interface Window {
    /** Exposed by the preload script. The renderer's only way to reach the main process. */
    readonly api: RendererApi;
  }
}

export {};
