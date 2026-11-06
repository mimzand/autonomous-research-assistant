import { z } from 'zod';

/*
 * Runtime settings: the single typed definition of every user-configurable
 * setting. Main validates with these schemas before anything is applied or
 * persisted; the renderer uses the same metadata to render the Settings page.
 *
 * Precedence (lowest → highest): built-in default → environment (.env,
 * settings.env, process environment) → value saved in the Settings page
 * (SQLite). Resetting a setting removes the saved value, so it falls back to
 * the environment value or the built-in default.
 */

export const SETTINGS_CATEGORIES = [
  'general',
  'models',
  'ollama',
  'research',
  'storage',
  'security',
  'advanced',
] as const;
export type SettingsCategory = (typeof SETTINGS_CATEGORIES)[number];

export const SETTINGS_CATEGORY_LABELS: Readonly<Record<SettingsCategory, string>> = {
  general: 'General',
  models: 'AI Models',
  ollama: 'Ollama Connection',
  research: 'Research & Web Search',
  storage: 'Storage',
  security: 'Security',
  advanced: 'Advanced',
};

/** When a change takes effect. Nothing in this app needs a restart. */
export type SettingApplies =
  /** The next request or action uses the new value. */
  | 'immediately'
  /** Running tasks keep the configuration they started with; new tasks use the new value. */
  | 'new-tasks'
  /** Read once when the app starts (e.g. the start page). No restart is forced. */
  | 'next-start';

export const START_SECTIONS = [
  'chat',
  'tasks',
  'knowledge',
  'reports',
  'research-tools',
  'settings',
] as const;

/** Ollama model names, e.g. "qwen3:8b", "library/llama3.2:3b-instruct-q4_K_M". */
export const ModelNameSchema = z
  .string()
  .trim()
  .min(1, 'Choose a model.')
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/, 'Not a valid Ollama model name.');

const httpUrl = (what: string) =>
  z
    .string()
    .trim()
    .max(2048)
    .superRefine((value, ctx) => {
      const problem = serverUrlProblem(value);
      if (problem) ctx.addIssue({ code: 'custom', message: `${what}: ${problem}` });
    });

const ms = (min: number, max: number) => z.int().min(min).max(max);

/** Value schemas, keyed by setting. `null` means "not set: use the model's own default". */
export const SettingsValuesSchema = z.strictObject({
  // General
  'general.startSection': z.enum(START_SECTIONS),
  'general.showStartupChecks': z.boolean(),
  // AI models
  'model.name': ModelNameSchema,
  'model.temperature': z.number().min(0).max(2).nullable(),
  'model.topP': z.number().gt(0, 'Top P must be greater than 0.').max(1).nullable(),
  'model.topK': z.int().min(1).max(1000).nullable(),
  'model.numCtx': z.int().min(512).max(262_144),
  'model.numPredict': z.int().min(1).max(131_072).nullable(),
  'model.repeatPenalty': z.number().min(0).max(2).nullable(),
  'model.generateTimeoutMs': ms(1000, 3_600_000),
  // Ollama connection
  'ollama.baseUrl': httpUrl('Ollama URL'),
  'ollama.requestTimeoutMs': ms(500, 600_000),
  // Research & web search
  'searxng.url': httpUrl('SearXNG URL').nullable(),
  'searxng.safeSearch': z.union([z.literal(0), z.literal(1), z.literal(2)]),
  'web.searchTimeoutMs': ms(1000, 120_000),
  'research.resultsPerQuery': z.int().min(1).max(10),
  'web.fetchTimeoutMs': ms(1000, 120_000),
  'web.maxDownloadBytes': z
    .int()
    .min(64 * 1024)
    .max(50 * 1024 * 1024),
  'web.maxTextChars': z.int().min(10_000).max(5_000_000),
  'web.maxPdfPages': z.int().min(1).max(2000),
  'research.maxQuestions': z.int().min(1).max(6),
  'research.maxSources': z.int().min(1).max(12),
  // Storage
  'backup.defaultDirectory': z.string().max(1024).nullable(),
  // Security
  'security.requireHttpsForRemote': z.boolean(),
  // Advanced
  'ollama.streamIdleTimeoutMs': ms(1000, 3_600_000),
  'research.modelRetries': z.int().min(0).max(3),
  'research.toolRetries': z.int().min(0).max(3),
  'research.retryBackoffMs': z.int().min(0).max(60_000),
  'research.modelTimeoutMs': ms(1000, 900_000),
});
export type SettingsValues = z.infer<typeof SettingsValuesSchema>;
export type SettingKey = keyof SettingsValues;
export const SETTING_KEYS = Object.keys(SettingsValuesSchema.shape) as SettingKey[];

/** Secrets: write-only from the renderer, stored encrypted, never sent back. */
export const SECRET_SETTING_KEYS = ['ollama.authToken'] as const;
export type SecretSettingKey = (typeof SECRET_SETTING_KEYS)[number];

export type SettingKind =
  'text' | 'url' | 'integer' | 'number' | 'boolean' | 'select' | 'model' | 'directory';

export interface SettingDefinition {
  readonly key: SettingKey;
  readonly category: SettingsCategory;
  readonly label: string;
  readonly description: string;
  readonly kind: SettingKind;
  readonly applies: SettingApplies;
  /** Built-in default (before the environment). */
  readonly builtin: unknown;
  /** Environment variable that can provide the default. */
  readonly env?: string;
  readonly unit?: 'ms' | 'bytes' | 'tokens' | 'characters' | 'pages';
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  /** For `select`. */
  readonly options?: readonly { readonly value: string | number; readonly label: string }[];
  /** `null` is allowed and means "use the model's default" (not sent to Ollama). */
  readonly nullable?: boolean;
  /** Placeholder shown when the value is null. */
  readonly nullLabel?: string;
  /** Changed only by a dedicated action (e.g. a folder picker), not by typing. */
  readonly dedicatedAction?: boolean;
}

const MiB = 1024 * 1024;

export const SETTING_DEFINITIONS: readonly SettingDefinition[] = [
  // --- General ---------------------------------------------------------------
  {
    key: 'general.startSection',
    category: 'general',
    label: 'Start page',
    description: 'Page shown when the app opens.',
    kind: 'select',
    applies: 'next-start',
    builtin: 'chat',
    options: [
      { value: 'chat', label: 'Chat' },
      { value: 'tasks', label: 'Tasks' },
      { value: 'knowledge', label: 'Knowledge Base' },
      { value: 'reports', label: 'Reports' },
      { value: 'research-tools', label: 'Research Tools' },
      { value: 'settings', label: 'Settings' },
    ],
  },
  {
    key: 'general.showStartupChecks',
    category: 'general',
    label: 'Show startup checks',
    description:
      'Banner above every page when Ollama is unreachable, the model is missing or web search is not configured.',
    kind: 'boolean',
    applies: 'immediately',
    builtin: true,
  },
  // --- AI models -------------------------------------------------------------
  {
    key: 'model.name',
    category: 'models',
    label: 'Active model',
    description:
      'Model used for chat and new research tasks. Choose from the models installed on the Ollama server.',
    kind: 'model',
    applies: 'new-tasks',
    builtin: 'qwen3:8b',
    env: 'OLLAMA_MODEL',
  },
  {
    key: 'model.temperature',
    category: 'models',
    label: 'Temperature',
    description: 'Randomness of the answers (0 = deterministic). Empty: the model default.',
    kind: 'number',
    applies: 'new-tasks',
    builtin: null,
    nullable: true,
    nullLabel: 'Model default',
    min: 0,
    max: 2,
    step: 0.05,
  },
  {
    key: 'model.topP',
    category: 'models',
    label: 'Top P',
    description:
      'Nucleus sampling: only the most likely tokens up to this probability mass are considered.',
    kind: 'number',
    applies: 'new-tasks',
    builtin: null,
    nullable: true,
    nullLabel: 'Model default',
    min: 0.01,
    max: 1,
    step: 0.01,
  },
  {
    key: 'model.topK',
    category: 'models',
    label: 'Top K',
    description: 'Only the K most likely tokens are considered.',
    kind: 'integer',
    applies: 'new-tasks',
    builtin: null,
    nullable: true,
    nullLabel: 'Model default',
    min: 1,
    max: 1000,
  },
  {
    key: 'model.numCtx',
    category: 'models',
    label: 'Context length (num_ctx)',
    description:
      'Tokens the model can see at once. Larger values need more (V)RAM; 4096 keeps most of an 8B model on a 6 GB GPU.',
    kind: 'integer',
    applies: 'new-tasks',
    builtin: 4096,
    env: 'OLLAMA_NUM_CTX',
    unit: 'tokens',
    min: 512,
    max: 262_144,
    step: 512,
  },
  {
    key: 'model.numPredict',
    category: 'models',
    label: 'Maximum output tokens (num_predict)',
    description:
      'Upper limit for one answer. Empty: no limit set by the app. Research steps use their own smaller limits.',
    kind: 'integer',
    applies: 'new-tasks',
    builtin: null,
    nullable: true,
    nullLabel: 'No limit',
    unit: 'tokens',
    min: 1,
    max: 131_072,
  },
  {
    key: 'model.repeatPenalty',
    category: 'models',
    label: 'Repeat penalty',
    description: 'Penalises repeating the same tokens (1 = off).',
    kind: 'number',
    applies: 'new-tasks',
    builtin: null,
    nullable: true,
    nullLabel: 'Model default',
    min: 0,
    max: 2,
    step: 0.05,
  },
  {
    key: 'model.generateTimeoutMs',
    category: 'models',
    label: 'Request timeout',
    description:
      'Deadline for one complete (non-streaming) answer. The first request also loads the model into memory.',
    kind: 'integer',
    applies: 'new-tasks',
    builtin: 300_000,
    env: 'OLLAMA_GENERATE_TIMEOUT_MS',
    unit: 'ms',
    min: 1000,
    max: 3_600_000,
    step: 1000,
  },
  // --- Ollama connection -----------------------------------------------------
  {
    key: 'ollama.baseUrl',
    category: 'ollama',
    label: 'Server URL',
    description:
      'Address of the Ollama server, e.g. http://127.0.0.1:11434, http://192.168.1.100:11434 or https://ollama.example.com.',
    kind: 'url',
    applies: 'new-tasks',
    builtin: 'http://127.0.0.1:11434',
    env: 'OLLAMA_HOST',
  },
  {
    key: 'ollama.requestTimeoutMs',
    category: 'ollama',
    label: 'Connection timeout',
    description: 'Deadline for connection checks and model list requests.',
    kind: 'integer',
    applies: 'immediately',
    builtin: 5000,
    env: 'OLLAMA_REQUEST_TIMEOUT_MS',
    unit: 'ms',
    min: 500,
    max: 600_000,
    step: 500,
  },
  // --- Research & web search -------------------------------------------------
  {
    key: 'searxng.url',
    category: 'research',
    label: 'SearXNG URL',
    description:
      'Your SearXNG instance with JSON output enabled. Empty: web search is off. No API key is needed.',
    kind: 'url',
    applies: 'immediately',
    builtin: null,
    env: 'SEARXNG_URL',
    nullable: true,
    nullLabel: 'Not configured',
  },
  {
    key: 'searxng.safeSearch',
    category: 'research',
    label: 'Safe search',
    description: 'SearXNG safe search level.',
    kind: 'select',
    applies: 'immediately',
    builtin: 1,
    env: 'SEARXNG_SAFESEARCH',
    options: [
      { value: 0, label: 'Off' },
      { value: 1, label: 'Moderate' },
      { value: 2, label: 'Strict' },
    ],
  },
  {
    key: 'web.searchTimeoutMs',
    category: 'research',
    label: 'Search timeout',
    description: 'Deadline for one search request.',
    kind: 'integer',
    applies: 'immediately',
    builtin: 15_000,
    env: 'WEB_SEARCH_TIMEOUT_MS',
    unit: 'ms',
    min: 1000,
    max: 120_000,
    step: 1000,
  },
  {
    key: 'research.resultsPerQuery',
    category: 'research',
    label: 'Maximum search results',
    description: 'Results requested per search query in new research tasks.',
    kind: 'integer',
    applies: 'new-tasks',
    builtin: 5,
    min: 1,
    max: 10,
  },
  {
    key: 'web.fetchTimeoutMs',
    category: 'research',
    label: 'Web fetch timeout',
    description: 'Deadline for downloading one page, including redirects.',
    kind: 'integer',
    applies: 'immediately',
    builtin: 20_000,
    env: 'WEB_FETCH_TIMEOUT_MS',
    unit: 'ms',
    min: 1000,
    max: 120_000,
    step: 1000,
  },
  {
    key: 'web.maxDownloadBytes',
    category: 'research',
    label: 'Maximum fetched content size',
    description: 'Larger downloads and files are refused.',
    kind: 'integer',
    applies: 'immediately',
    builtin: 15 * MiB,
    env: 'WEB_MAX_DOWNLOAD_BYTES',
    unit: 'bytes',
    min: 64 * 1024,
    max: 50 * MiB,
    step: 1024 * 1024,
  },
  {
    key: 'web.maxTextChars',
    category: 'research',
    label: 'Maximum extracted document size',
    description:
      'Characters of text kept from one page or document; the rest is cut and marked as truncated.',
    kind: 'integer',
    applies: 'immediately',
    builtin: 1_000_000,
    unit: 'characters',
    min: 10_000,
    max: 5_000_000,
    step: 10_000,
  },
  {
    key: 'web.maxPdfPages',
    category: 'research',
    label: 'Maximum PDF pages',
    description: 'Pages read from one PDF.',
    kind: 'integer',
    applies: 'immediately',
    builtin: 300,
    unit: 'pages',
    min: 1,
    max: 2000,
  },
  {
    key: 'research.maxQuestions',
    category: 'research',
    label: 'Questions per task',
    description: 'Sub-questions in a research plan (new tasks).',
    kind: 'integer',
    applies: 'new-tasks',
    builtin: 3,
    env: 'RESEARCH_MAX_QUESTIONS',
    min: 1,
    max: 6,
  },
  {
    key: 'research.maxSources',
    category: 'research',
    label: 'Sources per task',
    description: 'Sources read in a research task (new tasks).',
    kind: 'integer',
    applies: 'new-tasks',
    builtin: 6,
    env: 'RESEARCH_MAX_SOURCES',
    min: 1,
    max: 12,
  },
  // --- Storage ---------------------------------------------------------------
  {
    key: 'backup.defaultDirectory',
    category: 'storage',
    label: 'Backup folder',
    description:
      'Folder the backup Save dialog opens in. You still choose and confirm every backup file. Empty: Documents.',
    kind: 'directory',
    applies: 'immediately',
    builtin: null,
    nullable: true,
    nullLabel: 'Documents',
    dedicatedAction: true,
  },
  // --- Security --------------------------------------------------------------
  {
    key: 'security.requireHttpsForRemote',
    category: 'security',
    label: 'Require HTTPS for remote servers',
    description:
      'Refuse plain http:// for Ollama and SearXNG servers that are not on this computer. Loopback (127.0.0.1) is always allowed.',
    kind: 'boolean',
    applies: 'immediately',
    builtin: false,
  },
  // --- Advanced --------------------------------------------------------------
  {
    key: 'ollama.streamIdleTimeoutMs',
    category: 'advanced',
    label: 'Streaming idle timeout',
    description:
      'A streamed chat answer fails if no data arrives for this long (covers model loading).',
    kind: 'integer',
    applies: 'immediately',
    builtin: 120_000,
    env: 'OLLAMA_STREAM_IDLE_TIMEOUT_MS',
    unit: 'ms',
    min: 1000,
    max: 3_600_000,
    step: 1000,
  },
  {
    key: 'research.modelRetries',
    category: 'advanced',
    label: 'Model retries',
    description:
      'Extra attempts after a failed model call in research (invalid JSON, timeout, server error).',
    kind: 'integer',
    applies: 'new-tasks',
    builtin: 1,
    env: 'RESEARCH_MODEL_RETRIES',
    min: 0,
    max: 3,
  },
  {
    key: 'research.toolRetries',
    category: 'advanced',
    label: 'Tool retries',
    description: 'Extra attempts after a transient search or fetch failure.',
    kind: 'integer',
    applies: 'new-tasks',
    builtin: 1,
    env: 'RESEARCH_TOOL_RETRIES',
    min: 0,
    max: 3,
  },
  {
    key: 'research.retryBackoffMs',
    category: 'advanced',
    label: 'Retry delay',
    description: 'First retry delay; doubles on each attempt (max 30 s).',
    kind: 'integer',
    applies: 'new-tasks',
    builtin: 1000,
    env: 'RESEARCH_RETRY_BACKOFF_MS',
    unit: 'ms',
    min: 0,
    max: 60_000,
    step: 100,
  },
  {
    key: 'research.modelTimeoutMs',
    category: 'advanced',
    label: 'Research model call timeout',
    description: 'Deadline for one model call in a research step.',
    kind: 'integer',
    applies: 'new-tasks',
    builtin: 300_000,
    env: 'RESEARCH_MODEL_TIMEOUT_MS',
    unit: 'ms',
    min: 1000,
    max: 900_000,
    step: 1000,
  },
];

export const SETTING_DEFINITION_BY_KEY: ReadonlyMap<SettingKey, SettingDefinition> = new Map(
  SETTING_DEFINITIONS.map((d) => [d.key, d]),
);

/** Settings that only take effect after a restart. Empty by design. */
export const RESTART_REQUIRED_KEYS: readonly SettingKey[] = [];

// --- Server URLs -----------------------------------------------------------------

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Loopback, private network (RFC 1918, link-local, ULA, .local) or anything else. */
export function classifyHost(hostname: string): 'loopback' | 'private' | 'public' {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (LOOPBACK_HOSTS.has(host) || /^127\.\d+\.\d+\.\d+$/.test(host)) return 'loopback';
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'private';
    if (a === 169 && b === 254) return 'private';
    if (a === 100 && b >= 64 && b <= 127) return 'private'; // CGNAT / Tailscale
    return 'public';
  }
  if (/^f[cd][0-9a-f]{2}:/.test(host) || /^fe80:/.test(host)) return 'private';
  if (
    host.endsWith('.local') ||
    host.endsWith('.lan') ||
    host.endsWith('.internal') ||
    !host.includes('.')
  ) {
    return 'private';
  }
  return 'public';
}

/** Why a server URL (Ollama, SearXNG) is not acceptable, or null. */
export function serverUrlProblem(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'enter a full URL such as http://127.0.0.1:11434.';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    return 'only http:// and https:// are supported.';
  if (!url.hostname) return 'the host name is missing.';
  if (url.username || url.password) {
    return 'do not put a user name or password in the URL; use the access token setting instead.';
  }
  if (url.search || url.hash) return 'the URL must not contain a query (?…) or fragment (#…).';
  if (['0.0.0.0', '[::]'].includes(url.hostname))
    return '0.0.0.0 is a listen address; use 127.0.0.1.';
  return null;
}

/**
 * Normalises a server URL as Ollama's own client does: without a scheme,
 * "host" means http://host:11434 and "host:port" means http://host:port; with
 * a scheme and no port, the scheme's default port (80/443) is used. A path
 * prefix (reverse proxy) is kept; a trailing slash is removed.
 */
export function normalizeServerUrl(raw: string, defaultPort = 11434): string {
  const value = raw.trim().replace(/\/+$/, '');
  if (!value) return value;
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
  if (hasScheme) {
    try {
      const url = new URL(value);
      // Leave anything unusual (credentials, query, fragment) for validation to reject.
      if (url.username || url.password || url.search || url.hash) return value;
      return `${url.protocol}//${url.host}${url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '')}`;
    } catch {
      return value;
    }
  }
  try {
    const url = new URL(`http://${value}`);
    if (url.username || url.password || url.search || url.hash) return `http://${value}`;
    const port = url.port || String(defaultPort);
    return `http://${url.hostname}:${port}${url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return value;
  }
}

export interface ConnectionAdvice {
  readonly location: 'loopback' | 'private' | 'public';
  readonly encrypted: boolean;
  /** Plain HTTP to another machine. */
  readonly warnings: readonly string[];
}

/** Security advice for a server URL (shown before connecting). */
export function connectionAdvice(value: string): ConnectionAdvice {
  const url = new URL(value);
  const location = classifyHost(url.hostname);
  const encrypted = url.protocol === 'https:';
  const warnings: string[] = [];
  if (!encrypted && location === 'private') {
    warnings.push(
      'Plain HTTP to another computer: prompts and answers travel unencrypted on your network. Prefer HTTPS or a VPN (e.g. WireGuard, Tailscale).',
    );
  }
  if (!encrypted && location === 'public') {
    warnings.push(
      'Plain HTTP over the internet: anyone on the path can read and change prompts and answers. Use HTTPS with an access token, or a VPN. Never expose an unauthenticated Ollama port to the internet.',
    );
  }
  return { location, encrypted, warnings };
}

/** Whether `requireHttpsForRemote` refuses this URL. */
export function violatesHttpsPolicy(value: string, requireHttps: boolean): boolean {
  if (!requireHttps) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && classifyHost(url.hostname) !== 'loopback';
  } catch {
    return false;
  }
}

/** The access token is only ever sent over HTTPS or to this computer. */
export function canSendCredentials(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || classifyHost(url.hostname) === 'loopback';
  } catch {
    return false;
  }
}

// --- IPC contract ---------------------------------------------------------------

export const SettingSourceSchema = z.enum(['default', 'environment', 'saved']);
export type SettingSource = z.infer<typeof SettingSourceSchema>;

const Json = z.json();

export const SettingsViewSchema = z.object({
  /** Effective values (what the app uses now). */
  values: SettingsValuesSchema,
  entries: z.record(
    z.string(),
    z.object({
      source: SettingSourceSchema,
      /** Value used when the saved value is reset (environment or built-in). */
      defaultValue: Json,
      /** Environment variable that set the default, if any. */
      envVar: z.string().nullable(),
    }),
  ),
  secrets: z.record(z.string(), z.object({ set: z.boolean() })),
  /** OS encryption (DPAPI on Windows) is available for secrets. */
  encryptionAvailable: z.boolean(),
  /** Keys whose new value only applies after a restart and were changed since start. */
  pendingRestart: z.array(z.string()),
  /** Value of general.startSection when the app started. */
  startedWith: z.object({ startSection: z.enum(START_SECTIONS) }),
});
export type SettingsView = z.infer<typeof SettingsViewSchema>;

/** A partial update from the renderer. Unknown keys are rejected. */
export const SettingsPatchSchema = z.record(z.string(), Json);
export type SettingsPatch = Partial<SettingsValues>;

export const SettingsResetRequestSchema = z.strictObject({
  /** Omit to reset every setting (not secrets). */
  keys: z.array(z.string()).max(SETTING_KEYS.length).optional(),
});

export const SettingErrorsSchema = z.record(z.string(), z.string());
export type SettingErrors = z.infer<typeof SettingErrorsSchema>;

export const SettingsUpdateResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('saved'),
    view: SettingsViewSchema,
    changed: z.array(z.string()),
    warnings: z.array(z.string()),
  }),
  z.object({ status: z.literal('invalid'), errors: SettingErrorsSchema }),
  /** Validation passed but applying failed; nothing was changed (rolled back). */
  z.object({ status: z.literal('failed'), message: z.string() }),
]);
export type SettingsUpdateResult = z.infer<typeof SettingsUpdateResultSchema>;

export const SettingsValidateResultSchema = z.object({
  ok: z.boolean(),
  errors: SettingErrorsSchema,
  warnings: z.array(z.string()),
});
export type SettingsValidateResult = z.infer<typeof SettingsValidateResultSchema>;

export const SecretUpdateRequestSchema = z.strictObject({
  key: z.enum(SECRET_SETTING_KEYS),
  /** New value; empty string or null clears the secret. Never returned. */
  value: z.string().max(4096).nullable(),
});

export const SettingsChangedEventSchema = z.object({
  changed: z.array(z.string()),
  view: SettingsViewSchema,
});
export type SettingsChangedEvent = z.infer<typeof SettingsChangedEventSchema>;

// --- Ollama connection & models ----------------------------------------------------

export const ServerUrlRequestSchema = z.strictObject({
  /** Candidate URL to test; omit to test the saved one. */
  url: z.string().trim().max(2048).optional(),
});

export const ConnectionTestResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    url: z.string(),
    /** Server version (Ollama); null for services that do not report one. */
    version: z.string().nullable(),
    latencyMs: z.int().nonnegative(),
    warnings: z.array(z.string()),
    checkedAt: z.iso.datetime(),
  }),
  z.object({
    ok: z.literal(false),
    url: z.string(),
    /** e.g. unavailable, timeout, http-error, redirect, invalid-url, policy */
    code: z.string(),
    error: z.string(),
    hint: z.string().nullable(),
    latencyMs: z.int().nonnegative().nullable(),
    warnings: z.array(z.string()),
    checkedAt: z.iso.datetime(),
  }),
]);
export type ConnectionTestResult = z.infer<typeof ConnectionTestResultSchema>;

export const OllamaConnectionStateSchema = z.object({
  /** Disconnect stops all requests to Ollama until Connect (not persisted). */
  connected: z.boolean(),
  url: z.string(),
  /** Whether an access token is configured and will be sent to this URL. */
  tokenConfigured: z.boolean(),
  tokenSent: z.boolean(),
  warnings: z.array(z.string()),
});
export type OllamaConnectionState = z.infer<typeof OllamaConnectionStateSchema>;

export const OllamaModelSummarySchema = z.object({
  name: z.string(),
  family: z.string().nullable(),
  families: z.array(z.string()),
  parameterSize: z.string().nullable(),
  quantization: z.string().nullable(),
  format: z.string().nullable(),
  sizeBytes: z.int().nonnegative().nullable(),
  modifiedAt: z.string().nullable(),
  digest: z.string().nullable(),
});
export type OllamaModelSummary = z.infer<typeof OllamaModelSummarySchema>;

export const OllamaModelListSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    url: z.string(),
    models: z.array(OllamaModelSummarySchema),
    activeModel: z.string(),
    /** False when the selected model is not installed on this server (anymore). */
    activeModelAvailable: z.boolean(),
    fetchedAt: z.iso.datetime(),
  }),
  z.object({
    status: z.literal('error'),
    url: z.string(),
    code: z.string(),
    error: z.string(),
    activeModel: z.string(),
  }),
]);
export type OllamaModelList = z.infer<typeof OllamaModelListSchema>;

export const ModelNameRequestSchema = z.strictObject({ name: ModelNameSchema });

export const OllamaModelDetailsSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    name: z.string(),
    capabilities: z.array(z.string()),
    family: z.string().nullable(),
    parameterSize: z.string().nullable(),
    quantization: z.string().nullable(),
    format: z.string().nullable(),
    contextLength: z.int().positive().nullable(),
    architecture: z.string().nullable(),
    /** Model-file defaults (e.g. "temperature 0.6"), truncated. */
    parameters: z.string().nullable(),
    license: z.string().nullable(),
    modifiedAt: z.string().nullable(),
  }),
  z.object({ status: z.literal('error'), name: z.string(), code: z.string(), error: z.string() }),
]);
export type OllamaModelDetails = z.infer<typeof OllamaModelDetailsSchema>;

export const ModelTestRequestSchema = z.strictObject({
  name: ModelNameSchema,
  prompt: z.string().trim().min(1).max(500),
});

export const ModelTestResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    model: z.string(),
    reply: z.string(),
    truncated: z.boolean(),
    durationMs: z.int().nonnegative(),
    promptTokens: z.int().nonnegative().nullable(),
    completionTokens: z.int().nonnegative().nullable(),
    options: z.record(z.string(), Json),
  }),
  z.object({ status: z.literal('error'), model: z.string(), code: z.string(), error: z.string() }),
]);
export type ModelTestResult = z.infer<typeof ModelTestResultSchema>;

/** What is actually sent to Ollama for the active model. */
export const EffectiveModelConfigSchema = z.object({
  url: z.string(),
  model: z.string(),
  /** Ollama `options` sent with every chat request (null = left to the model). */
  options: z.record(z.string(), Json),
  generateTimeoutMs: z.int(),
  streamIdleTimeoutMs: z.int(),
  /** Values the research workflow sets per step for reliable JSON, overriding the defaults above. */
  researchOverrides: z.record(z.string(), Json),
  /** Model defaults reported by /api/show (e.g. "temperature 0.6"), when available. */
  modelDefaults: z.string().nullable(),
});
export type EffectiveModelConfig = z.infer<typeof EffectiveModelConfigSchema>;

/** Same rule as the Ollama provider: "qwen3" matches "qwen3:latest"; otherwise names must match. */
export function matchesModelName(installedName: string, wanted: string): boolean {
  if (installedName === wanted) return true;
  return !wanted.includes(':') && installedName === `${wanted}:latest`;
}

/** Example server addresses shown in the Settings page. */
export const OLLAMA_URL_EXAMPLES = {
  local: 'http://127.0.0.1:11434',
  network: 'http://192.168.1.100:11434',
  remote: 'https://ollama.example.com',
} as const;
