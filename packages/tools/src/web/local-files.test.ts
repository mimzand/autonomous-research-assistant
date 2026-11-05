import { describe, expect, it } from 'vitest';
import { buildDocx, buildPdf, paragraph } from './extract/test-documents.js';
import { type HttpResponse, type SafeHttpClient, WebError } from './http-client.js';
import { detectLocalKind, extractLocalDocument, fileExtension } from './local-files.js';
import { createSearxngProvider } from './search.js';

describe('local document extraction', () => {
  const pdf = buildPdf([['Local PDF text']], { title: 'Local' });
  const docx = buildDocx(paragraph('Local DOCX text'));

  it('reads extensions case-insensitively', () => {
    expect(fileExtension('Report.PDF')).toBe('pdf');
    expect(fileExtension('archive.tar.gz')).toBe('gz');
    expect(fileExtension('no-extension')).toBe('');
    expect(fileExtension('dir.v2/file')).toBe('');
  });

  it('extracts PDF and DOCX with size and hash', async () => {
    expect(await extractLocalDocument('a.pdf', pdf, { maxBytes: 1e6 })).toMatchObject({
      kind: 'pdf',
      title: 'Local',
      text: 'Local PDF text',
      contentType: 'application/pdf',
      byteLength: pdf.length,
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(await extractLocalDocument('b.docx', docx, { maxBytes: 1e6 })).toMatchObject({
      kind: 'docx',
      text: 'Local DOCX text',
    });
  });

  it('refuses other types and files whose content does not match the extension', () => {
    for (const name of ['a.exe', 'a.html', 'a.txt', 'a.zip', 'noext']) {
      expect(() => detectLocalKind(name, pdf), name).toThrow(/Only PDF and DOCX/);
    }
    expect(() => detectLocalKind('fake.pdf', docx)).toThrow(/not a PDF/);
    expect(() => detectLocalKind('fake.docx', pdf)).toThrow(/not a Word document/);
  });

  it('refuses files above the size limit', async () => {
    await expect(extractLocalDocument('a.pdf', pdf, { maxBytes: 10 })).rejects.toMatchObject({
      code: 'too-large',
    });
  });
});

describe('SearXNG health check', () => {
  function http(responses: Record<string, number>) {
    const calls: string[] = [];
    const client: SafeHttpClient = {
      async get(url) {
        calls.push(new URL(url).pathname);
        const status = responses[new URL(url).pathname] ?? 404;
        if (status !== 200) throw new WebError('http-error', `HTTP ${status}`, status);
        return {
          requestedUrl: url,
          finalUrl: url,
          redirects: [],
          status,
          headers: {},
          contentType: 'text/plain',
          body: Buffer.from('OK'),
          remoteAddress: '127.0.0.1',
        } satisfies HttpResponse;
      },
    };
    return { client, calls };
  }

  it('uses /healthz, falling back to /config on older instances', async () => {
    const modern = http({ '/healthz': 200 });
    const provider = createSearxngProvider({ baseUrl: 'http://127.0.0.1:8080/' }, modern.client);
    expect(await provider.checkHealth()).toMatchObject({
      provider: 'searxng',
      endpoint: 'http://127.0.0.1:8080',
    });
    const older = http({ '/config': 200 });
    await createSearxngProvider({ baseUrl: 'http://127.0.0.1:8080' }, older.client).checkHealth();
    expect(older.calls).toEqual(['/healthz', '/config']);
  });

  it('reports an unhealthy instance', async () => {
    const down = http({ '/healthz': 503 });
    await expect(
      createSearxngProvider({ baseUrl: 'http://127.0.0.1:8080' }, down.client).checkHealth(),
    ).rejects.toMatchObject({ code: 'http-error', status: 503 });
  });
});
