import { readFileSync } from 'node:fs';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { type AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createSafeHttpClient,
  type Resolver,
  type SafeHttpClientOptions,
  WebError,
} from './http-client.js';

const fixture = (name: string) =>
  readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8');

/** Fake public DNS. The ".test" names resolve to documentation addresses that pass the policy. */
const DNS: Record<string, string[]> = {
  'public.test': ['203.0.113.10'],
  'other.test': ['203.0.113.11'],
  'secure.test': ['203.0.113.20'],
  'wrong-name.test': ['203.0.113.21'],
  'rebind.test': ['10.0.0.5'],
  'metadata-rebind.test': ['169.254.169.254'],
  'mixed.test': ['203.0.113.12', '127.0.0.1'],
  'mapped.test': ['::ffff:192.168.1.10'],
};
const resolve: Resolver = async (host) => {
  const addresses = DNS[host];
  if (!addresses) throw new Error('ENOTFOUND');
  return addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
};

const requests: string[] = [];
let httpPort = 0;
let httpsPort = 0;

function routes(req: IncomingMessage, res: ServerResponse): void {
  const path = req.url ?? '/';
  requests.push(`${req.headers.host}${path}`);
  const redirect = (status: number, location?: string) => {
    res.writeHead(status, location === undefined ? {} : { location });
    res.end();
  };
  const chain = /^\/chain\/(\d+)$/.exec(path);
  if (chain) {
    const n = Number(chain[1]);
    if (n === 0) return void res.end('end of chain');
    return redirect(302, `/chain/${n - 1}`);
  }
  switch (path) {
    case '/ok':
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'a=b' });
      return void res.end(`<h1>Hello</h1><p>${req.headers['user-agent']}</p>`);
    case '/headers':
      res.writeHead(200, { 'content-type': 'application/json' });
      return void res.end(JSON.stringify(req.headers));
    case '/relative':
      return redirect(301, '/ok');
    case '/cross-origin':
      return redirect(307, 'http://other.test/ok');
    case '/303':
      return redirect(303, '/ok');
    case '/loop':
      return redirect(302, '/loop');
    case '/no-location':
      return redirect(302);
    case '/to-loopback':
      return redirect(302, 'http://127.0.0.1/admin');
    case '/to-localhost':
      return redirect(302, `http://localhost:${httpPort}/ok`);
    case '/to-metadata':
      return redirect(302, 'http://169.254.169.254/latest/meta-data/');
    case '/to-rebind':
      return redirect(302, 'http://rebind.test/ok');
    case '/to-file':
      return redirect(302, 'file:///etc/passwd');
    case '/to-credentials':
      return redirect(302, 'http://admin:secret@public.test/ok');
    case '/downgrade':
      return redirect(302, 'http://public.test/ok');
    case '/declared-big':
      res.writeHead(200, { 'content-length': String(5 * 1024 * 1024) });
      return void res.end();
    case '/streamed-big':
      res.writeHead(200, { 'content-type': 'text/plain' }); // chunked, no length
      for (let i = 0; i < 40; i++) res.write(Buffer.alloc(64 * 1024, 97));
      return void res.end();
    case '/gzip':
      res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' });
      return void res.end(gzipSync('compressed hello'));
    case '/gzip-bomb': {
      // ~50 KB on the wire, 64 MB when inflated.
      res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' });
      return void res.end(gzipSync(Buffer.alloc(64 * 1024 * 1024)));
    }
    case '/weird-encoding':
      res.writeHead(200, { 'content-encoding': 'compress' });
      return void res.end('x');
    case '/missing':
      res.writeHead(404);
      return void res.end('not here');
    case '/hang':
      return; // Never answers.
    default:
      res.writeHead(500);
      res.end();
  }
}

const httpServer = createHttpServer(routes);
const httpsServer = createHttpsServer(
  { key: fixture('test-tls.key'), cert: fixture('test-tls.crt') },
  routes,
);

beforeAll(async () => {
  await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', r));
  await new Promise<void>((r) => httpsServer.listen(0, '127.0.0.1', r));
  httpPort = (httpServer.address() as AddressInfo).port;
  httpsPort = (httpsServer.address() as AddressInfo).port;
});
afterAll(() => {
  httpServer.closeAllConnections();
  httpsServer.closeAllConnections();
  httpServer.close();
  httpsServer.close();
});

/**
 * Client whose fake DNS answers are validated like real ones; only AFTER the
 * address passed the policy is the socket redirected to the local test server.
 */
function client(options: SafeHttpClientOptions = {}) {
  return createSafeHttpClient({
    resolve,
    connectOverride: ({ port }) => ({
      host: '127.0.0.1',
      port: port === 443 ? httpsPort : httpPort,
    }),
    ca: fixture('test-tls.crt'),
    timeoutMs: 2000,
    ...options,
  });
}

async function failure(promise: Promise<unknown>): Promise<WebError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(WebError);
    return error as WebError;
  }
  throw new Error('Expected the request to fail.');
}

describe('safe HTTP client: basics', () => {
  it('fetches a page and reports where it came from', async () => {
    const res = await client().get('http://public.test/ok');
    expect(res).toMatchObject({
      requestedUrl: 'http://public.test/ok',
      finalUrl: 'http://public.test/ok',
      redirects: [],
      status: 200,
      contentType: 'text/html; charset=utf-8',
      remoteAddress: '203.0.113.10',
    });
    expect(res.body.toString()).toContain('AutonomousResearchAssistant');
  });

  it('sends the original Host header, no cookies and no credentials', async () => {
    const res = await client().get('http://public.test/headers');
    const headers = JSON.parse(res.body.toString()) as Record<string, string>;
    expect(headers['host']).toBe('public.test');
    expect(headers['cookie']).toBeUndefined();
    expect(headers['authorization']).toBeUndefined();
  });

  it('decompresses gzip', async () => {
    expect((await client().get('http://public.test/gzip')).body.toString()).toBe(
      'compressed hello',
    );
  });

  it('reports HTTP errors with their status', async () => {
    const error = await failure(client().get('http://public.test/missing'));
    expect(error).toMatchObject({ code: 'http-error', status: 404 });
  });
});

describe('safe HTTP client: redirects', () => {
  it('follows relative, cross-origin and 303 redirects and records each hop', async () => {
    const res = await client().get('http://public.test/relative');
    expect(res.finalUrl).toBe('http://public.test/ok');
    expect(res.redirects).toEqual(['http://public.test/relative']);

    const cross = await client().get('http://public.test/cross-origin');
    expect(cross).toMatchObject({
      finalUrl: 'http://other.test/ok',
      remoteAddress: '203.0.113.11',
    });

    expect((await client().get('http://public.test/303')).finalUrl).toBe('http://public.test/ok');
  });

  it('follows up to the redirect limit and no further', async () => {
    const res = await client({ maxRedirects: 3 }).get('http://public.test/chain/3');
    expect(res.redirects).toHaveLength(3);
    expect(res.body.toString()).toBe('end of chain');

    const error = await failure(client({ maxRedirects: 3 }).get('http://public.test/chain/4'));
    expect(error.code).toBe('too-many-redirects');
    expect((await failure(client().get('http://public.test/loop'))).code).toBe(
      'too-many-redirects',
    );
  });

  it('rejects a redirect without a Location header', async () => {
    expect((await failure(client().get('http://public.test/no-location'))).code).toBe(
      'invalid-redirect',
    );
  });

  it('refuses redirects to non-http schemes and to URLs with credentials', async () => {
    expect((await failure(client().get('http://public.test/to-file'))).code).toBe('blocked-url');
    expect((await failure(client().get('http://public.test/to-credentials'))).code).toBe(
      'blocked-url',
    );
  });

  it('refuses https -> http downgrades', async () => {
    const error = await failure(client().get('https://secure.test/downgrade'));
    expect(error.code).toBe('redirect-downgrade');
  });
});

describe('safe HTTP client: SSRF protection', () => {
  it('refuses private targets without sending any request (real resolver, no overrides)', async () => {
    const plain = createSafeHttpClient({ timeoutMs: 2000 });
    const before = requests.length;
    for (const url of [
      `http://127.0.0.1:${httpPort}/ok`,
      'http://127.0.0.1/ok',
      'http://localhost/ok',
      'http://[::1]/ok',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.1/',
      'file:///etc/passwd',
    ]) {
      expect((await failure(plain.get(url))).code, url).toBe('blocked-url');
    }
    expect(requests.length).toBe(before);
  });

  it('refuses redirects into the local network, before connecting', async () => {
    const before = requests.length;
    for (const path of ['/to-loopback', '/to-localhost', '/to-metadata']) {
      const error = await failure(client().get(`http://public.test${path}`));
      expect(error.code, path).toBe('blocked-url');
    }
    expect(requests.length - before).toBe(3); // Only the three redirecting requests.
  });

  it('validates DNS answers: names that resolve to private addresses are refused', async () => {
    const before = requests.length;
    for (const host of ['rebind.test', 'metadata-rebind.test', 'mapped.test']) {
      const error = await failure(client().get(`http://${host}/ok`));
      expect(error.code, host).toBe('blocked-address');
    }
    expect(requests.length).toBe(before);
  });

  it('refuses a name if ANY of its addresses is private', async () => {
    const error = await failure(client().get('http://mixed.test/ok'));
    expect(error).toMatchObject({
      code: 'blocked-address',
      message: expect.stringContaining('loopback'),
    });
  });

  it('refuses a redirect to a name that resolves to a private address', async () => {
    const error = await failure(client().get('http://public.test/to-rebind'));
    expect(error.code).toBe('blocked-address');
  });

  it('reports DNS failures', async () => {
    expect((await failure(client().get('http://unknown.test/'))).code).toBe('dns-failed');
  });

  it('lets only an explicitly trusted origin be private (the configured search server)', async () => {
    const trusted = createSafeHttpClient({
      trustedOrigins: [`http://127.0.0.1:${httpPort}`],
      timeoutMs: 2000,
    });
    const res = await trusted.get(`http://127.0.0.1:${httpPort}/ok`);
    expect(res.status).toBe(200);
    // Other private origins are still refused, including redirects off the trusted one.
    expect((await failure(trusted.get('http://127.0.0.1/ok'))).code).toBe('blocked-url');
    expect((await failure(trusted.get(`http://127.0.0.1:${httpPort}/to-metadata`))).code).toBe(
      'blocked-url',
    );
  });
});

describe('safe HTTP client: TLS while pinned to an IP', () => {
  it('verifies the certificate against the original host name', async () => {
    const res = await client().get('https://secure.test/ok');
    expect(res).toMatchObject({ status: 200, finalUrl: 'https://secure.test/ok' });
  });

  it('rejects a certificate for a different host name', async () => {
    const error = await failure(client().get('https://wrong-name.test/ok'));
    expect(error.code).toBe('network-error');
    expect(error.message).toMatch(/altnames|certificate|Hostname/i);
  });

  it('rejects an untrusted certificate', async () => {
    const error = await failure(
      createSafeHttpClient({
        resolve,
        connectOverride: () => ({ host: '127.0.0.1', port: httpsPort }),
        timeoutMs: 2000,
      }).get('https://secure.test/ok'),
    );
    expect(error.code).toBe('network-error');
  });
});

describe('safe HTTP client: limits', () => {
  it('refuses responses whose declared size is too large', async () => {
    const error = await failure(
      client({ maxBytes: 1024 * 1024 }).get('http://public.test/declared-big'),
    );
    expect(error.code).toBe('too-large');
  });

  it('stops streamed responses at the limit', async () => {
    const error = await failure(
      client({ maxBytes: 1024 * 1024 }).get('http://public.test/streamed-big'),
    );
    expect(error.code).toBe('too-large');
  });

  it('stops decompression bombs at the limit', async () => {
    const error = await failure(
      client({ maxBytes: 1024 * 1024 }).get('http://public.test/gzip-bomb'),
    );
    expect(error.code).toBe('too-large');
  });

  it('allows a smaller per-request limit but never a larger one', async () => {
    const small = await failure(
      client({ maxBytes: 4 * 1024 * 1024 }).get('http://public.test/streamed-big', {
        maxBytes: 1024,
      }),
    );
    expect(small.code).toBe('too-large');
    const capped = await failure(
      client({ maxBytes: 1024 }).get('http://public.test/streamed-big', { maxBytes: 100_000_000 }),
    );
    expect(capped.code).toBe('too-large');
  });

  it('refuses unknown content encodings', async () => {
    expect((await failure(client().get('http://public.test/weird-encoding'))).code).toBe(
      'unsupported-content',
    );
  });

  it('times out', async () => {
    const started = Date.now();
    const error = await failure(client({ timeoutMs: 150 }).get('http://public.test/hang'));
    expect(error.code).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('can be cancelled', async () => {
    const controller = new AbortController();
    const pending = client().get('http://public.test/hang', { signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    expect((await failure(pending)).code).toBe('cancelled');
  });
});
