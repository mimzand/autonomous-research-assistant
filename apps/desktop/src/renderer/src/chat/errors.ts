import { type ChatErrorCode } from '@rka/shared';

export interface ChatErrorView {
  readonly code: ChatErrorCode;
  readonly title: string;
  readonly hint: string | null;
  /** Technical detail from the main process, shown in smaller text. */
  readonly detail: string;
}

/** Turns a chat error into something a person can act on. */
export function describeChatError(
  code: ChatErrorCode,
  detail: string,
  model: string,
): ChatErrorView {
  switch (code) {
    case 'unavailable':
      return {
        code,
        title: 'Cannot connect to Ollama',
        hint: 'Make sure Ollama is running, then send your message again.',
        detail,
      };
    case 'model-not-found':
      return {
        code,
        title: `Model ${model} is not installed`,
        hint: `Install it with: ollama pull ${model}`,
        detail,
      };
    case 'timeout':
      return {
        code,
        title: 'The model took too long to respond',
        hint: 'The model may still be loading into memory. Try again in a moment.',
        detail,
      };
    case 'invalid-response':
      return {
        code,
        title: 'Unexpected response from Ollama',
        hint: 'Check that the configured server is Ollama and try again.',
        detail,
      };
    case 'unsupported':
      return { code, title: 'Not supported by this model', hint: null, detail };
    case 'invalid-request':
      return { code, title: 'The message could not be sent', hint: null, detail };
    case 'busy':
      return {
        code,
        title: 'Already generating',
        hint: 'Stop the current response first.',
        detail,
      };
    case 'generation-failed':
      return { code, title: 'Generation failed', hint: 'Try sending the message again.', detail };
  }
}
