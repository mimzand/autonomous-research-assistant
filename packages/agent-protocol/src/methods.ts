import {
  BackupResultSchema,
  CancelRequestSchema,
  ChatEventSchema,
  ChatStartRequestSchema,
  ChatStartResultSchema,
  ChatStopRequestSchema,
  ConnectionTestResultSchema,
  EffectiveModelConfigSchema,
  err,
  ExtractionResultSchema,
  IntegrityCheckResultSchema,
  ModelHealthSchema,
  ModelNameRequestSchema,
  ModelTestRequestSchema,
  ModelTestResultSchema,
  ok,
  OllamaConnectionStateSchema,
  OllamaModelDetailsSchema,
  OllamaModelListSchema,
  OpenUrlRequestSchema,
  OpenUrlResultSchema,
  PickFileResultSchema,
  ReportDetailsSchema,
  ReportIdRequestSchema,
  ReportListQuerySchema,
  ReportListResultSchema,
  ResearchProgressEventSchema,
  ResearchToolsStatusSchema,
  SaveTestSourceRequestSchema,
  SaveTestSourceResultSchema,
  SearchHealthSchema,
  SECRET_SETTING_KEYS,
  ServerUrlRequestSchema,
  SettingsChangedEventSchema,
  SettingsPatchSchema,
  SettingsResetRequestSchema,
  SettingsUpdateResultSchema,
  SettingsValidateResultSchema,
  SettingsViewSchema,
  SourceDetailsSchema,
  SourceIdRequestSchema,
  SourceListQuerySchema,
  SourceListResultSchema,
  StartResearchRequestSchema,
  StorageStatusSchema,
  TaskActionResultSchema,
  TaskDetailsSchema,
  TaskIdRequestSchema,
  TaskListQuerySchema,
  TaskListResultSchema,
  TaskLogListSchema,
  TaskLogsRequestSchema,
  TaskStatusCountsSchema,
  ToolExtractFileRequestSchema,
  ToolFetchRequestSchema,
  ToolSearchRequestSchema,
  ToolSearchResultSchema,
  type Result,
} from '@rka/shared';
import { z } from 'zod';
import { type EventEnvelope, type RequestEnvelope } from './envelope.js';
import { describeIssues, protocolError, type ProtocolError } from './errors.js';
import { HelloAckSchema, HelloRequestSchema } from './handshake.js';

/** Which side receives (serves) the method. */
export type Direction = 'toAgent' | 'toShell';

/** Params of methods that take none. Senders send `{}`. */
export const NoParamsSchema = z.strictObject({});
/** Result of methods that return nothing. Responders send `null`. */
export const VoidResultSchema = z.null();

export const PingRequestSchema = z.strictObject({ nonce: z.string().max(64).optional() });
export const PongSchema = z.strictObject({
  nonce: z.string().max(64).optional(),
  agentTime: z.iso.datetime(),
});

/** Absolute local path chosen in a native dialog, or `null` when cancelled. Never sent to the renderer. */
export const ShellPathResultSchema = z.strictObject({
  path: z.string().min(1).max(4096).nullable(),
});
export const ShellChooseFolderRequestSchema = z.strictObject({
  defaultPath: z.string().min(1).max(4096).nullable(),
});
/**
 * A secret's ciphertext as the OS key store (Electron safeStorage) produced it,
 * base64. The agent stores it in SQLite without being able to read it.
 */
export const SecretCiphertextSchema = z
  .string()
  .min(4)
  .max(16_384)
  .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'Expected base64 ciphertext.');
/**
 * The agent asks the shell to decrypt a stored secret (Phase 7: the agent keeps
 * the ciphertext in SQLite; only the shell holds the key).
 */
export const ShellGetSecretRequestSchema = z.strictObject({
  key: z.enum(SECRET_SETTING_KEYS),
  ciphertext: SecretCiphertextSchema,
});
/** Decrypted secret, or `null` when unset/unreadable. Never logged. */
export const ShellGetSecretResultSchema = z.strictObject({
  value: z.string().max(4096).nullable(),
});
export const ShellEncryptionAvailableResultSchema = z.strictObject({ available: z.boolean() });

/**
 * Stores (or, with `null`, removes) a secret the shell already encrypted with
 * safeStorage. The plaintext never travels with it.
 */
export const StoreSecretRequestSchema = z.strictObject({
  key: z.enum(SECRET_SETTING_KEYS),
  ciphertext: SecretCiphertextSchema.nullable(),
});
/** `settings:choose-backup-folder`: the saved result, or `cancelled` when the dialog was closed. */
export const ChooseBackupFolderResultSchema = z.union([
  SettingsUpdateResultSchema,
  z.strictObject({ status: z.literal('cancelled') }),
]);

const request = <D extends Direction, P extends z.ZodType, R extends z.ZodType>(
  direction: D,
  phase: number,
  params: P,
  result: R,
) => ({ type: 'request', direction, phase, params, result }) as const;

const event = <P extends z.ZodType>(direction: Direction, phase: number, payload: P) =>
  ({ type: 'event', direction, phase, payload }) as const;

/**
 * Every method of the agent protocol. `phase` is the process-separation phase that
 * is planned to serve it (docs/agent-process-separation-plan.md); until then a
 * receiver answers `not_implemented`. Payloads reuse the `@rka/shared` schemas of
 * the matching renderer IPC channel, so both contracts cannot drift apart.
 *
 * Settings (Phase 7): the agent owns the settings and applies them live. A secret
 * is encrypted in the shell (safeStorage) and stored by the agent as ciphertext
 * (`settings.storeSecret`); the agent asks the shell to decrypt it
 * (`shell.getSecret`) and keeps the plaintext in memory only.
 */
export const PROTOCOL_METHODS = {
  // --- system (shell → agent) -------------------------------------------------------
  'system.hello': request('toAgent', 1, HelloRequestSchema, HelloAckSchema),
  'system.ping': request('toAgent', 1, PingRequestSchema, PongSchema),
  'system.shutdown': request('toAgent', 8, NoParamsSchema, VoidResultSchema),

  // --- chat ---------------------------------------------------------------------------
  'chat.start': request('toAgent', 4, ChatStartRequestSchema, ChatStartResultSchema),
  'chat.stop': request('toAgent', 4, ChatStopRequestSchema, VoidResultSchema),
  'chat.event': event('toShell', 4, ChatEventSchema),

  // --- tasks / research ---------------------------------------------------------------
  'tasks.counts': request('toAgent', 3, NoParamsSchema, TaskStatusCountsSchema),
  'tasks.list': request('toAgent', 3, TaskListQuerySchema, TaskListResultSchema),
  'tasks.get': request('toAgent', 3, TaskIdRequestSchema, TaskDetailsSchema.nullable()),
  'tasks.logs': request('toAgent', 3, TaskLogsRequestSchema, TaskLogListSchema),
  'tasks.runPersistenceCheck': request('toAgent', 3, NoParamsSchema, TaskActionResultSchema),
  'tasks.startResearch': request('toAgent', 5, StartResearchRequestSchema, TaskActionResultSchema),
  'tasks.pause': request('toAgent', 5, TaskIdRequestSchema, TaskActionResultSchema),
  'tasks.resume': request('toAgent', 5, TaskIdRequestSchema, TaskActionResultSchema),
  'tasks.cancel': request('toAgent', 5, TaskIdRequestSchema, TaskActionResultSchema),
  'tasks.retry': request('toAgent', 5, TaskIdRequestSchema, TaskActionResultSchema),

  // --- sources / reports / storage ----------------------------------------------------
  'sources.list': request('toAgent', 3, SourceListQuerySchema, SourceListResultSchema),
  'sources.get': request('toAgent', 3, SourceIdRequestSchema, SourceDetailsSchema.nullable()),
  'reports.list': request('toAgent', 3, ReportListQuerySchema, ReportListResultSchema),
  'reports.get': request('toAgent', 3, ReportIdRequestSchema, ReportDetailsSchema.nullable()),
  'storage.status': request('toAgent', 3, NoParamsSchema, StorageStatusSchema),
  'storage.integrityCheck': request('toAgent', 3, NoParamsSchema, IntegrityCheckResultSchema),
  /** The agent asks the shell for the destination via `shell.chooseBackupPath`. */
  'storage.backup': request('toAgent', 6, NoParamsSchema, BackupResultSchema),

  // --- research tools playground ------------------------------------------------------
  'researchTools.status': request('toAgent', 6, NoParamsSchema, ResearchToolsStatusSchema),
  'researchTools.checkSearch': request('toAgent', 6, NoParamsSchema, SearchHealthSchema),
  'researchTools.search': request('toAgent', 6, ToolSearchRequestSchema, ToolSearchResultSchema),
  'researchTools.fetchUrl': request('toAgent', 6, ToolFetchRequestSchema, ExtractionResultSchema),
  /** The agent asks the shell via `shell.chooseFile`; the path stays in the agent behind a token. */
  'researchTools.pickFile': request('toAgent', 6, NoParamsSchema, PickFileResultSchema),
  'researchTools.extractFile': request(
    'toAgent',
    6,
    ToolExtractFileRequestSchema,
    ExtractionResultSchema,
  ),
  'researchTools.saveSource': request(
    'toAgent',
    6,
    SaveTestSourceRequestSchema,
    SaveTestSourceResultSchema,
  ),
  'researchTools.openUrl': request('toAgent', 6, OpenUrlRequestSchema, OpenUrlResultSchema),
  'researchTools.cancel': request('toAgent', 6, CancelRequestSchema, VoidResultSchema),

  // --- settings -----------------------------------------------------------------------
  'settings.get': request('toAgent', 7, NoParamsSchema, SettingsViewSchema),
  'settings.validate': request('toAgent', 7, SettingsPatchSchema, SettingsValidateResultSchema),
  'settings.update': request('toAgent', 7, SettingsPatchSchema, SettingsUpdateResultSchema),
  'settings.reset': request('toAgent', 7, SettingsResetRequestSchema, SettingsUpdateResultSchema),
  'settings.testSearxng': request('toAgent', 7, ServerUrlRequestSchema, ConnectionTestResultSchema),
  /** Ciphertext only: the shell validates and encrypts the value with safeStorage first. */
  'settings.storeSecret': request(
    'toAgent',
    7,
    StoreSecretRequestSchema,
    SettingsUpdateResultSchema,
  ),
  /** The agent asks the requesting shell for the folder via `shell.chooseFolder`. */
  'settings.chooseBackupFolder': request(
    'toAgent',
    7,
    NoParamsSchema,
    ChooseBackupFolderResultSchema,
  ),

  // --- model (Ollama only) ------------------------------------------------------------
  'model.health': request('toAgent', 7, NoParamsSchema, ModelHealthSchema),
  'model.testConnection': request('toAgent', 7, ServerUrlRequestSchema, ConnectionTestResultSchema),
  'model.connectionState': request('toAgent', 7, NoParamsSchema, OllamaConnectionStateSchema),
  'model.connect': request('toAgent', 7, NoParamsSchema, OllamaConnectionStateSchema),
  'model.disconnect': request('toAgent', 7, NoParamsSchema, OllamaConnectionStateSchema),
  'model.listModels': request('toAgent', 7, NoParamsSchema, OllamaModelListSchema),
  'model.showModel': request('toAgent', 7, ModelNameRequestSchema, OllamaModelDetailsSchema),
  'model.testModel': request('toAgent', 7, ModelTestRequestSchema, ModelTestResultSchema),
  'model.effectiveConfig': request('toAgent', 7, NoParamsSchema, EffectiveModelConfigSchema),

  // --- UI fan-out (agent → shell push; the shell forwards to its windows) -------------
  'ui.researchProgress': event('toShell', 5, ResearchProgressEventSchema),
  'ui.settingsChanged': event('toShell', 7, SettingsChangedEventSchema),

  // --- shell ports (reverse RPC: agent → shell) ---------------------------------------
  'shell.chooseBackupPath': request('toShell', 6, NoParamsSchema, ShellPathResultSchema),
  'shell.chooseFile': request('toShell', 6, NoParamsSchema, ShellPathResultSchema),
  'shell.chooseFolder': request(
    'toShell',
    6,
    ShellChooseFolderRequestSchema,
    ShellPathResultSchema,
  ),
  /** The shell re-checks that the URL is a safe http(s) URL before opening it. */
  'shell.openExternal': request('toShell', 6, OpenUrlRequestSchema, VoidResultSchema),
  'shell.getSecret': request('toShell', 6, ShellGetSecretRequestSchema, ShellGetSecretResultSchema),
  'shell.encryptionAvailable': request(
    'toShell',
    6,
    NoParamsSchema,
    ShellEncryptionAvailableResultSchema,
  ),
} as const;

type Methods = typeof PROTOCOL_METHODS;
export type MethodName = keyof Methods;
export type RequestMethodName = {
  [M in MethodName]: Methods[M]['type'] extends 'request' ? M : never;
}[MethodName];
/**
 * How long the agent waits for a person in a shell dialog (`shell.choose*`). A
 * shell's own timeout for a request that opens one must be longer.
 */
export const SHELL_DIALOG_TIMEOUT_MS = 10 * 60_000;

/** Requests the shell serves (reverse RPC: agent → shell). */
export type ShellMethodName = {
  [M in RequestMethodName]: Methods[M]['direction'] extends 'toShell' ? M : never;
}[RequestMethodName];
export type EventName = {
  [M in MethodName]: Methods[M]['type'] extends 'event' ? M : never;
}[MethodName];

type ParamsSchemaOf<M> = M extends RequestMethodName ? Methods[M]['params'] : never;
type ResultSchemaOf<M> = M extends RequestMethodName ? Methods[M]['result'] : never;
type PayloadSchemaOf<M> = M extends EventName ? Methods[M]['payload'] : never;

/** What a caller passes (before defaults). */
export type RequestParamsInput<M extends RequestMethodName> = z.input<ParamsSchemaOf<M>>;
/** What the receiver gets after validation. */
export type RequestParams<M extends RequestMethodName> = z.output<ParamsSchemaOf<M>>;
export type RequestResult<M extends RequestMethodName> = z.output<ResultSchemaOf<M>>;
export type EventPayload<E extends EventName> = z.output<PayloadSchemaOf<E>>;

export type ParsedRequest = {
  [M in RequestMethodName]: {
    readonly id: string;
    readonly method: M;
    readonly params: RequestParams<M>;
  };
}[RequestMethodName];

export type ParsedEvent = {
  [E in EventName]: { readonly id: string; readonly method: E; readonly payload: EventPayload<E> };
}[EventName];

export function isMethodName(name: string): name is MethodName {
  return Object.hasOwn(PROTOCOL_METHODS, name);
}

/**
 * Validates an incoming request for the side identified by `receiver`. A method in
 * the wrong direction is reported as unknown, so the agent never serves `shell.*`
 * and the shell never serves agent methods.
 */
export function parseRequest(
  envelope: RequestEnvelope,
  receiver: Direction,
): Result<ParsedRequest, ProtocolError> {
  const { id, method, payload } = envelope;
  const def = isMethodName(method) ? PROTOCOL_METHODS[method] : undefined;
  if (def?.type !== 'request' || def.direction !== receiver) {
    return err(protocolError('unknown_method', `Unknown method: ${method}.`));
  }
  const parsed = (def.params as z.ZodType).safeParse(payload);
  if (!parsed.success) {
    return err(
      protocolError(
        'bad_request',
        `Invalid params for ${method} at: ${describeIssues(parsed.error)}.`,
      ),
    );
  }
  return ok({ id, method, params: parsed.data } as ParsedRequest);
}

/** Validates the payload of a `res` envelope against the result schema of `method`. */
export function parseResult<M extends RequestMethodName>(
  method: M,
  payload: unknown,
): Result<RequestResult<M>, ProtocolError> {
  const schema = PROTOCOL_METHODS[method].result as z.ZodType;
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    return err(
      protocolError(
        'bad_request',
        `Invalid result for ${method} at: ${describeIssues(parsed.error)}.`,
      ),
    );
  }
  return ok(parsed.data as RequestResult<M>);
}

/** Validates an incoming push event for the side identified by `receiver`. */
export function parseEvent(
  envelope: EventEnvelope,
  receiver: Direction,
): Result<ParsedEvent, ProtocolError> {
  const { id, method, payload } = envelope;
  const def = isMethodName(method) ? PROTOCOL_METHODS[method] : undefined;
  if (def?.type !== 'event' || def.direction !== receiver) {
    return err(protocolError('unknown_method', `Unknown event: ${method}.`));
  }
  const parsed = (def.payload as z.ZodType).safeParse(payload);
  if (!parsed.success) {
    return err(
      protocolError(
        'bad_request',
        `Invalid payload for ${method} at: ${describeIssues(parsed.error)}.`,
      ),
    );
  }
  return ok({ id, method, payload: parsed.data } as ParsedEvent);
}
