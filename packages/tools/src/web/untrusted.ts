/**
 * Web content is data, never instructions. When untrusted text is placed in a
 * model prompt it must be wrapped with `wrapUntrusted`, which:
 * - fences it in a uniquely-named block the system prompt tells the model to
 *   treat as quoted data,
 * - neutralises anything inside that would close the block early,
 * - strips control characters and invisible "format" characters that can hide
 *   instructions from the user.
 *
 * Tool calls are only ever parsed from the model's own structured tool-call
 * output, never from page text, so a page cannot invoke a tool by including
 * something that looks like a call.
 */

export const UNTRUSTED_OPEN = '<<<UNTRUSTED_WEB_CONTENT';
export const UNTRUSTED_CLOSE = 'UNTRUSTED_WEB_CONTENT>>>';

/** Removes C0/C1 controls (except tab/newline), zero-width and bidi override characters. */
export function stripInvisible(text: string): string {
  return (
    text
      // eslint-disable-next-line no-control-regex -- removing control characters is the point
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '')
      .replace(
        /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff\u{e0000}-\u{e007f}]/gu,
        '',
      )
  );
}

export function wrapUntrusted(
  text: string,
  source: { readonly url: string; readonly id?: string },
): string {
  const body = stripInvisible(text)
    .replaceAll(UNTRUSTED_CLOSE, '[removed marker]')
    .replaceAll(UNTRUSTED_OPEN, '[removed marker]');
  const label = `${source.id ? `id=${source.id} ` : ''}url=${JSON.stringify(source.url)}`;
  return `${UNTRUSTED_OPEN} ${label}\n${body}\n${UNTRUSTED_CLOSE}`;
}
