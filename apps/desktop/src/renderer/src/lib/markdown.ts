import MarkdownIt from 'markdown-it';

/**
 * Markdown → HTML for reports. Report text comes from the model and from
 * web sources, so it is untrusted:
 * - raw HTML in the Markdown is escaped, never rendered (`html: false`);
 * - only http(s) and in-page (#) links are kept; everything else is dropped;
 * - links open outside the app (the main process routes them to the system browser);
 * - images are not loaded (CSP blocks remote images anyway).
 * The CSP (`script-src 'self'`) is a second line of defence.
 */
const md = new MarkdownIt({ html: false, linkify: false, typographer: false, breaks: false });

const SAFE_LINK = /^(https?:\/\/|#)/i;
md.validateLink = (url: string) => SAFE_LINK.test(url.trim());

const defaultLinkOpen =
  md.renderer.rules['link_open'] ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));

md.renderer.rules['link_open'] = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const href = String(token?.attrGet('href') ?? '');
  if (token && /^https?:/i.test(href)) {
    token.attrSet('target', '_blank');
    token.attrSet('rel', 'noopener noreferrer');
  }
  return defaultLinkOpen(tokens, idx, options, env, self);
};

// Show image alt text instead of fetching remote images.
md.renderer.rules['image'] = (tokens, idx) => {
  const alt = md.utils.escapeHtml(tokens[idx]?.content ?? '');
  return `<span class="md-image-placeholder">[image: ${alt || 'untitled'}]</span>`;
};

export function renderMarkdown(source: string): string {
  return md.render(source);
}
