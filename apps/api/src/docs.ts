import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { type Hono } from 'hono';

/*
 * Swagger UI at /docs, served from the swagger-ui-dist package (no CDN): the page,
 * its CSS and JS bundle, and a small init script (no inline script, so the page can
 * use a strict Content-Security-Policy). The API key typed into "Authorize" stays in
 * the page's memory (persistAuthorization is off).
 */

const ASSETS = {
  'swagger-ui.css': 'text/css; charset=utf-8',
  'swagger-ui-bundle.js': 'text/javascript; charset=utf-8',
} as const;

const PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Research Assistant Agent API</title>
    <link rel="stylesheet" href="/docs/swagger-ui.css" />
  </head>
  <body>
    <div id="swagger"></div>
    <script src="/docs/swagger-ui-bundle.js"></script>
    <script src="/docs/init.js"></script>
  </body>
</html>
`;

const INIT = `window.ui = SwaggerUIBundle({
  url: '/openapi.json',
  dom_id: '#swagger',
  deepLinking: true,
  persistAuthorization: false,
  tryItOutEnabled: true,
});
`;

const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
  "connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export function mountDocs(app: Hono, openApi: () => unknown): void {
  const root = dirname(createRequire(import.meta.url).resolve('swagger-ui-dist/package.json'));
  const files = new Map(
    Object.entries(ASSETS).map(([name, type]) => [
      name,
      { body: readFileSync(join(root, name)), type },
    ]),
  );
  const page = (body: string, type: string) =>
    new Response(body, {
      headers: {
        'content-type': type,
        'content-security-policy': CSP,
        'cache-control': 'no-store',
      },
    });

  app.get('/openapi.json', (c) => c.json(openApi()));
  app.get('/docs', () => page(PAGE, 'text/html; charset=utf-8'));
  app.get('/docs/init.js', () => page(INIT, 'text/javascript; charset=utf-8'));
  app.get('/docs/:file', (c) => {
    const file = files.get(c.req.param('file'));
    if (!file) return c.notFound();
    return new Response(new Uint8Array(file.body), {
      headers: { 'content-type': file.type, 'cache-control': 'public, max-age=3600' },
    });
  });
}
