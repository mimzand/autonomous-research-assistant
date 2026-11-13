/**
 * Phase 7.5: why a source yields no text, and access-check pages. Scripted
 * HTTP responses only; no real site is contacted.
 */
import { describe, expect, it } from 'vitest';
import { createToolRegistry } from '../registry.js';
import { explainEmptyHtml, extractHtml, looksLikeAccessChallenge } from './extract/html.js';
import { buildPdf } from './extract/test-documents.js';
import { createWebFetcher, extractDocument } from './fetcher.js';
import { type HttpResponse, type SafeHttpClient, WebError } from './http-client.js';
import { type SourceStore } from './sources.js';
import { createFetchSourceTool } from './tools.js';

type Page = { type?: string; body: string | Uint8Array; status?: number } | { error: WebError };

function fakeHttp(pages: Record<string, Page>) {
  const calls: string[] = [];
  const http: SafeHttpClient = {
    async get(url) {
      calls.push(url);
      const page = pages[url];
      if (!page) throw new WebError('http-error', `HTTP 404 from ${new URL(url).host}.`, 404);
      if ('error' in page) throw page.error;
      return {
        requestedUrl: url,
        finalUrl: url,
        redirects: [],
        status: page.status ?? 200,
        headers: {},
        contentType: page.type ?? 'text/html; charset=utf-8',
        body: Buffer.from(page.body),
        remoteAddress: '203.0.113.1',
      } satisfies HttpResponse;
    },
  };
  return { http, calls };
}

function memoryStore() {
  const saved: string[] = [];
  const store: SourceStore = {
    findByUrl: () => undefined,
    findByContentHash: () => undefined,
    save: (_taskId, source) => {
      saved.push(source.url);
      return { id: `src-${saved.length}`, url: source.url, title: source.title };
    },
  };
  return { store, saved };
}

const ARTICLE = `<!doctype html><html><head><title>Introduction to SQLite</title></head><body>
<nav>Home | Tutorials</nav>
<article><h1>Introduction to SQLite</h1>
<p>SQLite is a small, self-contained, serverless SQL database engine that stores a whole database in one file.</p>
<p>Advantages: it needs no configuration or server process, and the database file is portable across platforms.</p>
</article><footer>© Example</footer></body></html>`;

async function fetchSource(pages: Record<string, Page>, url: string) {
  const { http } = fakeHttp(pages);
  const { store, saved } = memoryStore();
  const registry = createToolRegistry([
    createFetchSourceTool({ fetcher: createWebFetcher(http), store }),
  ]);
  const result = await registry.execute(
    'fetch_source',
    { url },
    { signal: new AbortController().signal, taskId: 't1' },
  );
  return { result, saved };
}

describe('HTML extraction diagnostics', () => {
  it('readable HTML: article text is extracted and nothing is reported as skipped', () => {
    const out = extractHtml(ARTICLE);
    expect(out.text).toContain('serverless SQL database engine');
    expect(out.text).not.toContain('Home | Tutorials');
    expect(looksLikeAccessChallenge(ARTICLE, out)).toBe(false);
  });

  it.each([
    ['empty body', '', 0, /empty response \(0 bytes\)/],
    [
      'JavaScript-only page',
      '<html><body><div id="root"></div><noscript>You need to enable JavaScript to run this app.</noscript><script>render()</script></body></html>',
      1,
      /only shows text when JavaScript runs/,
    ],
    [
      'all text hidden',
      '<html><body><div aria-hidden="true"><p>Some text that is hidden from readers.</p></div></body></html>',
      1,
      /hidden.*not read/,
    ],
    [
      'no visible text at all',
      '<html><head><title>App</title></head><body><div id="app"></div><script>load()</script></body></html>',
      1,
      /no visible text/,
    ],
  ])('%s → specific reason', (_name, html, bytes, reason) => {
    const out = extractHtml(html);
    expect(out.text).toBe('');
    expect(explainEmptyHtml(bytes === 0 ? 0 : html.length, out)).toMatch(reason);
  });

  it('a page wrapped in one <form> (e.g. ASP.NET) is read through the fallback; controls stay skipped', async () => {
    const html =
      '<html><body><form id="aspnetForm" method="post"><input type="hidden" name="__VIEWSTATE" value="x"/>' +
      '<div><p>SQLite stores the whole database in a single ordinary disk file.</p></div>' +
      '<button>Subscribe now</button><textarea>draft</textarea></form></body></html>';
    expect(extractHtml(html).text).toBe('');
    const doc = await extractDocument('html', Buffer.from(html));
    expect(doc.text).toContain('single ordinary disk file');
    expect(doc.text).not.toContain('Subscribe now');
    expect(doc.text).not.toContain('draft');
    expect(doc.emptyReason).toBeUndefined();
  });

  it('PDF advice only for PDFs: a PDF without a text layer says so', async () => {
    const doc = await extractDocument('pdf', buildPdf([[]]));
    expect(doc.text).toBe('');
    expect(doc.emptyReason).toMatch(/scanned PDFs are not supported/);
    const html = await extractDocument('html', Buffer.from('<html><body></body></html>'));
    expect(html.emptyReason).not.toMatch(/PDF/i);
  });
});

describe('access checks (bot protection / CAPTCHA)', () => {
  const CHALLENGE = `<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>
<div class="main-wrapper"><h1>example.com</h1><p>Verifying you are human. This may take a few seconds.</p></div>
<script>window._cf_chl_opt = { cType: 'managed' };</script></body></html>`;

  it.each([
    ['Cloudflare interstitial title', CHALLENGE],
    [
      'marker with little text',
      '<html><head><title>Example</title></head><body><form id="challenge-form" action="/x"></form><p>Checking your browser.</p></body></html>',
    ],
    [
      'access denied page',
      '<html><head><title>Access Denied</title></head><body><h1>Access Denied</h1><p>Reference #18.abc</p></body></html>',
    ],
  ])('%s is recognised', (_name, html) => {
    expect(looksLikeAccessChallenge(html, extractHtml(html))).toBe(true);
  });

  it('an article about Cloudflare challenges, or a normal page with a bot-detection script, is not a challenge', () => {
    const long = `<html><head><title>Just a moment...</title></head><body><article>${'<p>How managed challenges and the cf_chl_opt setting work in practice. </p>'.repeat(40)}</article></body></html>`;
    expect(looksLikeAccessChallenge(long, extractHtml(long))).toBe(false);
    const normal = ARTICLE.replace(
      '</body>',
      '<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script></body>',
    );
    expect(looksLikeAccessChallenge(normal, extractHtml(normal))).toBe(false);
  });

  it('a challenge page is refused (access-blocked), never saved as a source', async () => {
    const { result, saved } = await fetchSource(
      { 'https://blocked.example/page': { body: CHALLENGE } },
      'https://blocked.example/page',
    );
    expect(result).toMatchObject({ ok: false, error: { code: 'access-blocked' } });
    expect(saved).toEqual([]);
  });
});

describe('fetch_source error messages', () => {
  it('valid HTML is saved', async () => {
    const { result, saved } = await fetchSource(
      { 'https://ok.example/sqlite': { body: ARTICLE } },
      'https://ok.example/sqlite',
    );
    expect(result).toMatchObject({ ok: true, value: { status: 'saved', kind: 'html' } });
    expect(saved).toEqual(['https://ok.example/sqlite']);
  });

  it('empty HTML: a specific reason with HTTP status and size, and no PDF advice', async () => {
    const { result } = await fetchSource(
      {
        'https://js.example/app': {
          body: '<html><body><div id="root"></div><noscript>Enable JavaScript.</noscript></body></html>',
        },
      },
      'https://js.example/app',
    );
    expect(result).toMatchObject({ ok: false, error: { code: 'extraction-failed' } });
    const error = (result as { error: { message: string } }).error.message;
    expect(error).toMatch(
      /\(html, HTTP 200, \d+ bytes\): the page only shows text when JavaScript/,
    );
    expect(error).not.toMatch(/PDF/);
  });

  it('a scanned PDF keeps its PDF-specific reason', async () => {
    const { result } = await fetchSource(
      { 'https://docs.example/scan.pdf': { type: 'application/pdf', body: buildPdf([[]]) } },
      'https://docs.example/scan.pdf',
    );
    expect((result as { error: { message: string } }).error.message).toMatch(
      /\(pdf, .*scanned PDFs are not supported/,
    );
  });

  it('unsupported content types and HTTP failures keep their own codes', async () => {
    const image = await fetchSource(
      { 'https://img.example/a': { type: 'image/png', body: new Uint8Array([137, 80, 78, 71]) } },
      'https://img.example/a',
    );
    expect(image.result).toMatchObject({ ok: false, error: { code: 'unsupported-content' } });
    const denied = await fetchSource(
      {
        'https://forbidden.example/a': {
          error: new WebError('http-error', 'HTTP 403 from forbidden.example.', 403),
        },
      },
      'https://forbidden.example/a',
    );
    expect(denied.result).toMatchObject({ ok: false, error: { code: 'http-error' } });
  });

  it('SSRF protection still applies before any request', async () => {
    const { http, calls } = fakeHttp({});
    const { store } = memoryStore();
    const registry = createToolRegistry([
      createFetchSourceTool({ fetcher: createWebFetcher(http), store }),
    ]);
    const result = await registry.execute(
      'fetch_source',
      { url: 'http://169.254.169.254/latest' },
      { signal: new AbortController().signal, taskId: 't1' },
    );
    expect(result).toMatchObject({ ok: false, error: { code: 'blocked-url' } });
    expect(calls).toEqual([]);
  });
});
