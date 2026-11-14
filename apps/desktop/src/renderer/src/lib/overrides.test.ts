import { type SettingsView } from '@rka/shared';
import { describe, expect, it } from 'vitest';
import { effectiveConnection, origin, overrideState } from './settings';

type Entry = SettingsView['entries'][string];
const entry = (e: Partial<Entry>): Entry => ({
  source: 'default',
  defaultValue: null,
  envVar: null,
  overridden: false,
  envError: null,
  ...e,
});
const view = (
  values: Record<string, unknown>,
  entries: Record<string, Partial<Entry>>,
): SettingsView =>
  ({
    values,
    entries: Object.fromEntries(Object.entries(entries).map(([k, e]) => [k, entry(e)])),
  }) as unknown as SettingsView;

const TUNNEL = 'https://example-tunnel.ngrok-free.dev';

describe('Settings UI: environment overrides', () => {
  const overridden = view(
    { 'ollama.baseUrl': TUNNEL, 'model.name': 'qwen3.5:9b-mlx' },
    {
      'ollama.baseUrl': {
        source: 'environment',
        envVar: 'OLLAMA_HOST',
        overridden: true,
        savedValue: 'http://127.0.0.1:11434',
        defaultValue: 'http://127.0.0.1:11434',
      },
      'model.name': { source: 'saved', savedValue: 'qwen3.5:9b-mlx', defaultValue: 'qwen3:8b' },
    },
  );

  it('an overridden field is locked, labelled with its variable, and explains the restart', () => {
    expect(origin(overridden, 'ollama.baseUrl')).toMatchObject({
      tone: 'warn',
      label: 'Overridden by OLLAMA_HOST',
    });
    const state = overrideState(overridden, 'ollama.baseUrl');
    expect(state.locked).toBe(true);
    expect(state.note).toMatch(/OLLAMA_HOST.*restart the app/);
  });

  it('the saved value is shown only as the inactive fallback, never as the active value', () => {
    expect(overrideState(overridden, 'ollama.baseUrl').savedFallback).toBe(
      'http://127.0.0.1:11434',
    );
    expect(effectiveConnection(overridden)).toEqual({
      url: TUNNEL,
      urlSource: 'OLLAMA_HOST',
      model: 'qwen3.5:9b-mlx',
      modelSource: 'saved in Settings',
    });
  });

  it('a saved or default value is editable and not labelled as overridden', () => {
    expect(overrideState(overridden, 'model.name')).toEqual({
      locked: false,
      note: null,
      savedFallback: null,
      envError: null,
    });
    expect(origin(overridden, 'model.name').label).toBe('Customized');
  });

  it('an invalid variable shows its error on an editable field', () => {
    const v = view(
      { 'engine.chat': 'legacy' },
      {
        'engine.chat': {
          envVar: 'AGENT_ENGINE',
          envError: 'AGENT_ENGINE="turbo" is not used: use "legacy" or "adk".',
        },
      },
    );
    expect(overrideState(v, 'engine.chat')).toMatchObject({
      locked: false,
      envError: expect.stringMatching(/AGENT_ENGINE="turbo"/),
    });
    expect(origin(v, 'engine.chat').label).toBe('Default');
  });

  it('environment defaults of other settings keep their existing label', () => {
    const v = view(
      { 'searxng.url': 'http://127.0.0.1:8080' },
      { 'searxng.url': { source: 'environment', envVar: 'SEARXNG_URL' } },
    );
    expect(origin(v, 'searxng.url')).toMatchObject({ tone: 'info', label: 'From SEARXNG_URL' });
    expect(overrideState(v, 'searxng.url').locked).toBe(false);
  });
});
