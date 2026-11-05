import { Parser } from 'htmlparser2';
import { normalizeWhitespace } from './decode.js';

export interface HtmlExtraction {
  readonly title: string | null;
  readonly text: string;
  readonly description: string | null;
  readonly lang: string | null;
  readonly author: string | null;
  readonly publishedAt: string | null;
  readonly siteName: string | null;
  /** `<link rel="canonical">`, resolved against the page URL (http/https only). */
  readonly canonicalUrl: string | null;
  /** True when the text came from `<main>`/`<article>` rather than the whole body. */
  readonly usedMainContent: boolean;
}

/** Elements whose content is never text for the reader (or is executable). */
const SKIP = new Set([
  'title', // Captured separately.
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'math',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'canvas',
  'video',
  'audio',
  'map',
  'head',
  'nav',
  'aside',
  'footer',
  'form',
  'button',
  'select',
  'textarea',
  'dialog',
]);

/** Paragraph-level elements: separated by a blank line. */
const PARA = new Set([
  'address',
  'article',
  'blockquote',
  'details',
  'dl',
  'figure',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'main',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'ul',
]);

/** Line-level elements: start on a new line. */
const LINE = new Set([
  'body',
  'br',
  'dd',
  'div',
  'dt',
  'figcaption',
  'li',
  'summary',
  'tbody',
  'tfoot',
  'thead',
  'tr',
]);

/** Private-use character marking a paragraph break while text is assembled. */
const PARA_BREAK = '\ue000';

/** Turns runs of line/paragraph breaks into "\n" or "\n\n". */
function joinBlocks(parts: readonly string[]): string {
  return parts
    .join('')
    .replace(/[ \t]*([\n\ue000])[ \t]*/g, '$1')
    .replace(/[\n\ue000]+/g, (run) => (run.includes(PARA_BREAK) ? '\n\n' : '\n'));
}

/**
 * Text a browser would not show. Hidden text is a common carrier for prompt
 * injection ("ignore previous instructions..."), so it is dropped.
 */
function isHidden(attrs: Record<string, string>): boolean {
  if ('hidden' in attrs) return true;
  if (attrs['aria-hidden']?.trim().toLowerCase() === 'true') return true;
  if (attrs['type']?.toLowerCase() === 'hidden') return true;
  const style = attrs['style']?.toLowerCase().replace(/\s+/g, '') ?? '';
  return (
    style.includes('display:none') ||
    style.includes('visibility:hidden') ||
    style.includes('opacity:0;') ||
    style.endsWith('opacity:0') ||
    /font-size:0(?![.\d])/.test(style)
  );
}

function safeHttpUrl(value: string | undefined, base: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.trim(), base);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Extracts readable text and metadata from an HTML document. The page is only
 * parsed: no scripts run, no styles or subresources load, nothing is fetched.
 */
export function extractHtml(html: string, pageUrl?: string): HtmlExtraction {
  const meta = new Map<string, string>();
  let title = '';
  let inTitle = false;
  let titleDone = false;
  let firstH1 = '';
  let h1Depth = -1;
  let lang: string | null = null;
  let canonical: string | null = null;

  const stack: string[] = [];
  let skipAt = -1; // Stack depth at which a skipped subtree started.
  let mainAt = -1; // Stack depth of the outermost <main>/<article>.
  let preDepth = 0;
  const all: string[] = [];
  const main: string[] = [];

  const emit = (text: string) => {
    all.push(text);
    if (mainAt >= 0) main.push(text);
  };

  const parser = new Parser(
    {
      onopentag(name, attrs) {
        stack.push(name);
        const depth = stack.length;
        if (name === 'html' && attrs['lang']) lang = attrs['lang'].trim().slice(0, 35);
        if (name === 'title' && !titleDone && !stack.includes('svg')) inTitle = true;
        if (name === 'meta') {
          const key = (attrs['property'] ?? attrs['name'] ?? attrs['itemprop'] ?? '')
            .trim()
            .toLowerCase();
          const content = attrs['content']?.trim();
          if (key && content && !meta.has(key)) meta.set(key, content.slice(0, 2000));
        }
        if (name === 'link' && !canonical) {
          const rel = attrs['rel']?.toLowerCase().split(/\s+/) ?? [];
          if (rel.includes('canonical')) canonical = safeHttpUrl(attrs['href'], pageUrl);
        }
        if (skipAt >= 0) return;
        if (SKIP.has(name) || isHidden(attrs)) {
          skipAt = depth;
          return;
        }
        if ((name === 'main' || name === 'article') && mainAt < 0) mainAt = depth;
        if (name === 'pre') preDepth++;
        if (name === 'h1' && h1Depth < 0 && !firstH1) h1Depth = depth;
        if (PARA.has(name)) emit(PARA_BREAK);
        else if (LINE.has(name)) emit('\n');
        const heading = /^h([1-6])$/.exec(name);
        if (heading?.[1]) emit(`${'#'.repeat(Number(heading[1]))} `);
        if (name === 'li') emit('- ');
        if (name === 'td' || name === 'th') emit(' | ');
        if (name === 'img' && attrs['alt']?.trim()) emit(` ${attrs['alt'].trim()} `);
      },
      ontext(text) {
        if (inTitle) {
          title += text;
          return;
        }
        if (skipAt >= 0) return;
        if (h1Depth >= 0) firstH1 += text;
        if (preDepth > 0) {
          // Keep line breaks inside <pre>; normalizeWhitespace only trims lines.
          emit(text);
        } else {
          emit(text.replace(/\s+/g, ' '));
        }
      },
      onclosetag(name) {
        const depth = stack.length;
        if (name === 'title') {
          inTitle = false;
          if (title.trim()) titleDone = true;
        }
        if (skipAt < 0) {
          if (PARA.has(name)) emit(PARA_BREAK);
          else if (LINE.has(name)) emit('\n');
          if (name === 'pre' && preDepth > 0) preDepth--;
          if (depth === h1Depth) h1Depth = -1;
        }
        if (depth === skipAt) skipAt = -1;
        if (depth === mainAt) mainAt = -1;
        stack.pop();
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true },
  );
  parser.write(html);
  parser.end();

  const fullText = normalizeWhitespace(joinBlocks(all));
  const mainText = normalizeWhitespace(joinBlocks(main));
  // Use <main>/<article> only when it holds a real share of the page.
  const usedMainContent = mainText.length >= 200 && mainText.length >= fullText.length * 0.25;

  const pick = (...keys: string[]) => {
    for (const key of keys) {
      const value = meta.get(key);
      if (value) return value;
    }
    return null;
  };
  const clean = (text: string) => text.replace(/\s+/g, ' ').trim();

  return {
    title:
      clean(title).slice(0, 1000) ||
      pick('og:title', 'twitter:title') ||
      clean(firstH1).slice(0, 1000) ||
      null,
    text: usedMainContent ? mainText : fullText,
    description: pick('description', 'og:description', 'twitter:description'),
    lang,
    author: pick('author', 'article:author', 'og:article:author'),
    publishedAt: pick(
      'article:published_time',
      'og:article:published_time',
      'datepublished',
      'date',
      'dc.date',
    ),
    siteName: pick('og:site_name', 'application-name'),
    canonicalUrl: canonical,
    usedMainContent,
  };
}
