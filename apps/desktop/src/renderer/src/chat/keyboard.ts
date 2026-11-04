export interface KeyLike {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly isComposing?: boolean;
  readonly keyCode?: number;
}

/**
 * Enter sends; Shift+Enter inserts a newline. Never submit while an IME
 * composition is active (e.g. Persian/Chinese/Japanese input confirming a word).
 */
export function isSubmitKey(event: KeyLike): boolean {
  if (event.key !== 'Enter' || event.shiftKey) return false;
  if (event.isComposing || event.keyCode === 229) return false;
  return true;
}
