/**
 * Chat header connection label: follows the effective server URL reported by
 * the main process, including after Settings → Save (no restart).
 */
import { ollamaConnectionLabel, type ModelHealth, type SettingsChangedEvent } from '@rka/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Vue from 'vue';

// Run lifecycle hooks immediately (no DOM in these tests).
const unmounts: (() => void)[] = [];
vi.mock('vue', async (importOriginal) => ({
  ...(await importOriginal<typeof Vue>()),
  onMounted: (fn: () => void) => fn(),
  onBeforeUnmount: (fn: () => void) => void unmounts.push(fn),
}));

const health = (baseUrl: string): ModelHealth => ({
  provider: 'ollama',
  baseUrl,
  model: 'qwen3.5:9b-mlx',
  checkedAt: '2026-11-13T10:00:00.000Z',
  status: 'unreachable',
  reason: 'unavailable',
  error: 'x',
});

function fakeBridge() {
  let server = 'http://127.0.0.1:11434';
  let onChanged: ((e: SettingsChangedEvent) => void) | undefined;
  const pending: (() => void)[] = [];
  const getModelHealth = vi.fn(
    () =>
      new Promise<ModelHealth>((resolve) => {
        // The main process answers with the server configured when the check started.
        const url = server;
        pending.push(() => resolve(health(url)));
      }),
  );
  (globalThis as { window?: unknown }).window = {
    api: {
      getModelHealth,
      settings: {
        onChanged: (fn: typeof onChanged) => {
          onChanged = fn;
          return () => (onChanged = undefined);
        },
      },
    },
  };
  return {
    getModelHealth,
    /** Settings → Save: the main process applies the URL, then broadcasts the change. */
    save(url: string) {
      server = url;
      onChanged?.({ changed: ['ollama.baseUrl'] } as unknown as SettingsChangedEvent);
    },
    async answerAll() {
      while (pending.length) {
        pending.shift()?.();
        await new Promise((r) => setTimeout(r, 0));
      }
    },
  };
}

afterEach(() => {
  for (const fn of unmounts.splice(0)) fn();
  vi.resetModules();
});

async function setup() {
  const bridge = fakeBridge();
  const { useModelHealth } = await import('./useModelHealth');
  const h = useModelHealth();
  const label = () => (h.health.value ? ollamaConnectionLabel(h.health.value.baseUrl) : 'Ollama');
  return { bridge, label };
}

describe('Chat header connection label', () => {
  it('local server → Local Ollama', async () => {
    const { bridge, label } = await setup();
    await bridge.answerAll();
    expect(label()).toBe('Local Ollama');
  });

  it('switching to a remote server in Settings updates the label without a restart', async () => {
    const { bridge, label } = await setup();
    await bridge.answerAll();
    bridge.save('https://example-tunnel.ngrok-free.dev');
    await bridge.answerAll();
    expect(label()).toBe('Remote Ollama');
    bridge.save('http://127.0.0.1:11434');
    await bridge.answerAll();
    expect(label()).toBe('Local Ollama');
  });

  it('a save during a running check is not lost (the label does not stay stale)', async () => {
    const { bridge, label } = await setup();
    // The startup check (local) is still running when the user saves a remote URL.
    bridge.save('https://example-tunnel.ngrok-free.dev');
    await bridge.answerAll();
    expect(bridge.getModelHealth).toHaveBeenCalledTimes(2);
    expect(label()).toBe('Remote Ollama');
  });
});
