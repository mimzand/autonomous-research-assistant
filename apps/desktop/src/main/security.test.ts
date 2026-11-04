import { describe, expect, it } from 'vitest';
import { applyEnvText } from './env.js';
import { isAppUrl } from './security.js';

describe('isAppUrl', () => {
  it('allows only file:// pages in production', () => {
    expect(isAppUrl('file:///C:/app/out/renderer/index.html', undefined)).toBe(true);
    expect(isAppUrl('https://example.com', undefined)).toBe(false);
    expect(isAppUrl('not a url', undefined)).toBe(false);
  });

  it('allows only the dev server origin in development', () => {
    const dev = 'http://localhost:5173';
    expect(isAppUrl('http://localhost:5173/#/tasks', dev)).toBe(true);
    expect(isAppUrl('http://localhost:5174/', dev)).toBe(false);
    expect(isAppUrl('file:///C:/app/index.html', dev)).toBe(false);
  });
});

describe('applyEnvText', () => {
  it('applies new keys without overriding existing ones', () => {
    const env: NodeJS.ProcessEnv = { OLLAMA_MODEL: 'from-shell' };
    const applied = applyEnvText(
      '# comment\nOLLAMA_HOST=127.0.0.1:11434\nOLLAMA_MODEL=from-file\n',
      env,
    );
    expect(applied).toEqual(['OLLAMA_HOST']);
    expect(env).toEqual({ OLLAMA_MODEL: 'from-shell', OLLAMA_HOST: '127.0.0.1:11434' });
  });
});
