import { type ModelHealth, type ModelUnavailableReason } from '@rka/shared';

export type Tone = 'ok' | 'warn' | 'error' | 'pending';

export interface StatusLine {
  readonly label: string;
  readonly tone: Tone;
}

/** Everything the model status panel shows, derived from a health report. */
export interface ModelStatusView {
  readonly connection: StatusLine;
  readonly connectionDetail: string | null;
  readonly model: string;
  readonly availability: StatusLine;
  readonly serverUrl: string | null;
  readonly serverVersion: string | null;
  readonly capabilities: readonly string[];
  readonly contextLength: string | null;
  readonly structuredOutput: string | null;
  readonly hint: string | null;
  readonly checkedAt: string | null;
}

const REASON_TEXT: Record<ModelUnavailableReason, string> = {
  unavailable: 'Ollama is not running or cannot be reached.',
  timeout: 'Ollama did not respond in time.',
  'invalid-response': 'The server did not answer like Ollama.',
  'http-error': 'Ollama returned an error.',
  disconnected: 'Disconnected in Settings.',
};

const PENDING: ModelStatusView = {
  connection: { label: 'Checking…', tone: 'pending' },
  connectionDetail: null,
  model: '—',
  availability: { label: 'Checking…', tone: 'pending' },
  serverUrl: null,
  serverVersion: null,
  capabilities: [],
  contextLength: null,
  structuredOutput: null,
  hint: null,
  checkedAt: null,
};

export function describeModelStatus(
  health: ModelHealth | null,
  formatTime: (iso: string) => string = (iso) => new Date(iso).toLocaleTimeString(),
): ModelStatusView {
  if (!health) return PENDING;

  const common = {
    model: health.model,
    serverUrl: health.baseUrl,
    checkedAt: formatTime(health.checkedAt),
  };

  switch (health.status) {
    case 'ready':
      return {
        ...common,
        connection: { label: 'Connected', tone: 'ok' },
        connectionDetail: null,
        availability: { label: 'Installed', tone: 'ok' },
        serverVersion: health.serverVersion,
        capabilities: health.capabilities,
        contextLength:
          health.contextLength === null
            ? null
            : `${health.contextLength.toLocaleString('en-US')} tokens`,
        structuredOutput: health.structuredOutput ? 'Supported' : 'Not supported',
        hint: health.capabilities.includes('tools')
          ? null
          : 'This model does not report tool support; the research agent needs it.',
      };
    case 'model-missing':
      return {
        ...common,
        connection: { label: 'Connected', tone: 'ok' },
        connectionDetail: null,
        availability: { label: 'Not installed', tone: 'warn' },
        serverVersion: health.serverVersion,
        capabilities: [],
        contextLength: null,
        structuredOutput: null,
        hint: `Install it with: ollama pull ${health.model}. Installed: ${
          health.installedModels.join(', ') || 'none'
        }.`,
      };
    case 'unreachable':
      return {
        ...common,
        connection: { label: 'Not connected', tone: 'error' },
        connectionDetail: REASON_TEXT[health.reason],
        availability: { label: 'Unknown', tone: 'pending' },
        serverVersion: null,
        capabilities: [],
        contextLength: null,
        structuredOutput: null,
        hint:
          health.reason === 'unavailable'
            ? `${asSentence(health.error)} Start Ollama, then check again.`
            : asSentence(health.error),
      };
  }
}

function asSentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}
