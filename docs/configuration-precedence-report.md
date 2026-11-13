# Configuration precedence audit & unification

Scope: `OLLAMA_HOST`, `OLLAMA_MODEL`, `AGENT_ENGINE`, `RESEARCH_ENGINE`. No inference,
no live tests, no company endpoints contacted.

## 1. Root cause of the URL/model mismatch

Confirmed in code (`apps/desktop/src/main/config/runtime-config.ts`):

- Effective values were `merge = { ...builtin, ...environment, ...saved }`: **a saved value
  always beat the environment**, for every setting.
- `updateSettings` intentionally saves every explicitly submitted value **even when it equals
  the default**. Saving the Ollama form once (e.g. switching back to
  `http://127.0.0.1:11434`) left a `settings.ollama.baseUrl` row, after which `OLLAMA_HOST`
  could never take effect again.
- `OLLAMA_MODEL` only _appeared_ to work: no `settings.model.name` row existed, so the
  environment value was used as the **default layer**, not as an override. With a saved
  model it would have been ignored too.
- Result: the model came from the environment while the URL came from SQLite, so the
  local server was asked for the remote model → "model not installed".

Assumption (not verifiable without your database): your database holds a saved
`ollama.baseUrl` row and no `model.name` row. This is the only state consistent with what you saw.

Two more problems found in the audit:

- `resolveOllamaBaseUrl` silently replaced an unusable `OLLAMA_HOST` (e.g. `ftp://…`) with
  `127.0.0.1`, which hid configuration mistakes.
- An invalid `OLLAMA_MODEL` stopped startup, while an invalid engine variable was only
  logged.

Runtime consumers were already consistent with each other. The Ollama provider (Chat Legacy and ADK,
health/preflight, model list, connection state) and Research task capture/snapshots all
derive from `config.getSettings()` through the Ollama applier. So fixing the resolution in
one place fixes all of them.

## 2. Precedence: before and after

| Setting            | Before                               | After                                    |
| ------------------ | ------------------------------------ | ---------------------------------------- |
| `ollama.baseUrl`   | saved > `OLLAMA_HOST` > default      | **`OLLAMA_HOST` > saved > default**      |
| `model.name`       | saved > `OLLAMA_MODEL` > default     | **`OLLAMA_MODEL` > saved > default**     |
| `engine.chat`      | saved > `AGENT_ENGINE` > `legacy`    | **`AGENT_ENGINE` > saved > `legacy`**    |
| `engine.research`  | saved > `RESEARCH_ENGINE` > `legacy` | **`RESEARCH_ENGINE` > saved > `legacy`** |
| all other settings | saved > env > default                | unchanged                                |

How the environment variables are treated:

- **Absent or empty:** not an override.
- **Invalid:** not applied. The saved value or default stays active, and an actionable error
  appears in Settings and in the log.
- **Valid:** overrides the saved value, and the field becomes read-only.

**Security exceptions (documented and tested):**

- **HTTPS requirement:** "Require HTTPS for remote servers" is not overridable. A plain-HTTP
  remote `OLLAMA_HOST` is refused while it is on, and turning it on is refused while such an
  override is active.
- **Credentials in `OLLAMA_HOST`:** a user name, password, query or fragment is refused, and
  credentials are never echoed.
- **Access token:** Settings only, stored encrypted. It cannot come from the environment and
  is never shown.
- **`OLLAMA_NGROK_BYPASS_HOSTS`:** unchanged. It remains a main-process-only trust list.

## 3. Files changed

| File                                                     | Why                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/desktop/src/main/config/env-overrides.ts` (new)    | `resolveEnvOverrides(env)`: the single resolver for the four variables (validation, no silent fallback, credential redaction).                                                                                                                                                                     |
| `apps/desktop/src/main/config/runtime-config.ts`         | Applies overrides above saved values. Enforces the HTTPS policy on overrides. Rejects edits of overridden keys. Exposes `overridden`, `savedValue` and `envError` in the view. The four variables are no longer read as defaults.                                                                  |
| `packages/shared/src/settings.ts`                        | `ENV_OVERRIDE_KEYS`, `isEnvOverrideKey`. View entry fields `overridden`, `savedValue`, `envError`. Precedence doc comment.                                                                                                                                                                         |
| `apps/desktop/src/renderer/src/lib/settings.ts`          | `origin()` gains an "Overridden by VAR" badge. New helpers: `overrideState()`, `sourceText()`, `effectiveConnection()`.                                                                                                                                                                            |
| `…/components/settings/SettingField.vue`                 | Locks overridden fields. Shows the restart note, the inactive saved fallback and the env error.                                                                                                                                                                                                    |
| `…/components/settings/ModelsPanel.vue`                  | "Use" buttons are disabled while `OLLAMA_MODEL` overrides the model.                                                                                                                                                                                                                               |
| `…/components/settings/OllamaPanel.vue`                  | Shows "In use: URL (source) · model (source)" together.                                                                                                                                                                                                                                            |
| `apps/desktop/src/main/{chat-engine,research-engine}.ts` | Doc comments only.                                                                                                                                                                                                                                                                                 |
| Tests                                                    | New: `config/precedence.test.ts`, `renderer/src/lib/overrides.test.ts`. Updated: `config/runtime-config.test.ts`, `config/engine-settings.test.ts`, and the Phase 7.4.2 blocks in the Chat/Research integration tests. These tests encoded the old "saved wins" rule; they now assert the new one. |
| `.env.example`, `README.md`, `docs/settings.md`          | Document the policy. `OLLAMA_HOST` and `OLLAMA_MODEL` in `.env.example` are now **commented out**, so a copied `.env` no longer locks Settings by accident.                                                                                                                                        |

## 4. Resolution design

There is one resolution path at startup, in `createRuntimeConfig`, and no second mechanism:

1. **Defaults:** built-in defaults plus environment defaults (other settings only).
2. **Saved values:** read from SQLite. Invalid rows are ignored with a warning, as before.
3. **Overrides:** `resolveEnvOverrides(process.env)` returns, for each set variable, either a
   valid value or an error. `ollama.baseUrl` overrides are also checked against the
   effective HTTPS policy.
4. **Effective values:** `{ ...defaults, ...saved, ...overrides }`. They feed the provider
   (Ollama applier), the Chat engine selector and Research task capture. Saves, resets and
   reloads all re-merge with the same overrides.
5. **Per-key view for the renderer:** `source` (`environment` / `saved` / `default`),
   `overridden`, `envVar`, `savedValue` (the inactive fallback) and `envError`.

Overrides are never written to SQLite. Saving an overridden key is rejected with
"Set by the environment variable X. Remove the variable and restart the app…". **Reset**
of an overridden key only clears the saved fallback.

## 5. Settings UI behaviour

- **Overridden field:** read-only, with the badge **Overridden by `VAR`** and the note
  "Active value from the environment variable VAR. To change it here, remove the variable
  and restart the app." If a saved value exists, it is shown as "Saved value (inactive
  while overridden): …".
- **Invalid variable:** the field stays editable. The error (e.g. `AGENT_ENGINE="turbo" is
not used: use "legacy" or "adk". Fix or remove the variable and restart the app.`) is
  shown under it.
- **Ollama Connection:** shows the effective URL and model together, with their sources. The
  Chat header still derives Local/Remote from the effective URL.
- **Models:** "Use" is disabled while `OLLAMA_MODEL` is set.

## 6. Backward compatibility and migration

- No database migration. Saved rows are untouched and become active again when no override
  is set.
- **Behaviour change:** a set `OLLAMA_HOST`, `OLLAMA_MODEL`, `AGENT_ENGINE` or
  `RESEARCH_ENGINE` now wins over Settings. Anyone with these in `.env` or `settings.env`
  will see the fields locked. Your machine has no `.env` files, so nothing changes there
  until you set a variable.
- Engine variables stay case-insensitive. An invalid engine variable no longer forces
  `legacy`; the saved choice stays active and the error is shown.
- An invalid `OLLAMA_MODEL` no longer stops startup; it is reported and not applied.
  Invalid values of other variables still stop startup, as before.
- Research tasks keep their stored configuration and engine pin. Nothing is rewritten.
  Overrides apply only to new Chat requests and new Research tasks.

## 7. Tests

| Check               | Result                                     |
| ------------------- | ------------------------------------------ |
| `pnpm typecheck`    | pass                                       |
| `pnpm lint`         | pass                                       |
| `pnpm format:check` | pass                                       |
| `pnpm test`         | 77 files, **1035 tests passed** (was 1003) |
| `pnpm build`        | pass                                       |

New coverage:

- **Precedence and parsing:** env > saved > default for all four settings. Absent and empty
  variables. Invalid variables (URL scheme, credentials, query, model name, engine name).
- **URLs:** local and remote, an explicit HTTPS port and a path prefix.
- **Incident reproduction:** a saved local URL and saved model, plus `OLLAMA_HOST` and
  `OLLAMA_MODEL` → both overrides active. Health check `ready`, model list, Research
  capture, ngrok header and token all use the tunnel; the local server is never contacted.
- **Override lifecycle:** overrides are not persisted. Removing an override restores the
  saved value. Overridden fields are read-only. Reset only clears the fallback.
- **Security:** the HTTPS policy cannot be bypassed in either direction. Security settings
  and the token cannot be set from the environment. No token or URL password appears in the
  view or in errors. No ngrok header goes to local or untrusted hosts, and no token goes to a
  plain-HTTP remote.
- **Engines:** an `AGENT_ENGINE` override applies to new requests and cannot be switched
  from Settings. A `RESEARCH_ENGINE` override applies only to new tasks; existing tasks keep
  their pins, and the saved choice returns after the variable is removed.
- **UI:** badge, locking, inactive fallback and env-error rendering logic.

All existing Legacy/ADK parity, pinning, resume, retry and crash-recovery tests still pass.

## 8. Remaining risks

- The override state is resolved at startup. Changing a variable needs a restart, which is
  stated in the UI.
- Live behaviour against the real tunnel was not exercised. Only fake servers were used.
- UI rendering itself (Vue templates) is covered by typecheck and build plus the pure
  helpers; there are no DOM tests in this repo.
- `docs/adk-migration-phase7.3-report.md` (Phase 7.3) mentions the second company tunnel's
  host name in its risks section. Consider removing it if the repo will be shared.

## 9. Manual Windows acceptance checklist

1. Start without the variables (`Remove-Item Env:OLLAMA_HOST, Env:OLLAMA_MODEL -ErrorAction SilentlyContinue`; `pnpm dev`). Settings → Ollama Connection shows the saved URL and model with "saved in Settings" or "default". Fields are editable.
2. Close the app. Set `$env:OLLAMA_HOST = "https://<tunnel>.ngrok-free.dev"`, `$env:OLLAMA_MODEL = "qwen3.5:9b-mlx"` and `$env:OLLAMA_NGROK_BYPASS_HOSTS = "<tunnel>.ngrok-free.dev"`, then run `pnpm dev`.
3. Ollama Connection: the URL field shows the tunnel and **Overridden by OLLAMA_HOST**, is read-only, and shows the saved local URL as inactive. The "In use" line shows the tunnel and the model with their sources.
4. AI Models: the active model shows **Overridden by OLLAMA_MODEL**, and the "Use" buttons are disabled. With remote inference approved, the Chat header shows `qwen3.5:9b-mlx · Remote Ollama` and there is no "model not installed" error.
5. Set `$env:AGENT_ENGINE = "turbo"` and restart. Agent Engines shows the error under Chat engine, and the saved choice is still active.
6. Remove all variables and restart. The saved values are active again, and the fields are editable.
