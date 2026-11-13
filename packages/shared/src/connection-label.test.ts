import { describe, expect, it } from 'vitest';
import { ollamaConnectionLabel } from './index.js';

describe('ollamaConnectionLabel (Chat header)', () => {
  it.each([
    ['http://127.0.0.1:11434', 'Local Ollama'],
    ['http://localhost:11434', 'Local Ollama'],
    ['http://[::1]:11434', 'Local Ollama'],
    ['http://127.0.0.2:9000/ollama', 'Local Ollama'],
    ['https://example-tunnel.ngrok-free.dev', 'Remote Ollama'],
    ['https://ollama.example.com/ollama', 'Remote Ollama'],
    ['http://192.168.1.20:11434', 'Remote Ollama'],
    ['http://gpu-box:11434', 'Remote Ollama'],
    ['http://203.0.113.7:11434', 'Remote Ollama'],
    ['not a url', 'Ollama'],
  ])('%s → %s', (url, label) => {
    expect(ollamaConnectionLabel(url)).toBe(label);
  });

  it('depends on the server, not on the model or an HTTPS scheme alone', () => {
    // A loopback HTTPS proxy is still local; a remote plain-HTTP server is still remote.
    expect(ollamaConnectionLabel('https://127.0.0.1:8443')).toBe('Local Ollama');
    expect(ollamaConnectionLabel('http://10.0.0.5:11434')).toBe('Remote Ollama');
  });
});
