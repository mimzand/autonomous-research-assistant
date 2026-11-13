# Phase 7.4.2 — Legacy / Google ADK engine selection in Settings

## 1. Existing architecture findings

- **Settings framework** (`packages/shared/src/settings.ts`, `apps/desktop/src/main/config/runtime-config.ts`):
  one typed list of settings (`SettingsValuesSchema` + `SETTING_DEFINITIONS`), three layers
  — built-in default < environment (`.env`, `settings.env`, process env) < value saved from
  the Settings page in the SQLite `settings` table (`settings.<key>` rows). Main validates
  every change with Zod, applies it, persists it, then broadcasts `settings:changed`.
  Invalid saved rows are ignored with a warning. The renderer renders `select` settings
  generically (`SettingsForm` / `SettingField`) and shows each value's source.
- **Chat engine:** `createAppChatEngines` → `createChatEngineSelector`; the flag was read
  from `process.env.AGENT_ENGINE` **at the start of each request** (`ChatController.start`),
  so a running reply already kept its engine.
- **Research engine:** `researchTaskModelsFor(provider, { readFlag })`; the flag was read
  from `process.env.RESEARCH_ENGINE` **once in `capture()`** when a task is created, and
  pinned in `task.input.model.config.researchEngine`. Resume, Retry and crash recovery use
  `providerFor(captured)` → the pin, never the flag. Both selectors already accepted a
  `readFlag` callback.
- **Env parsing:** both flags were case-insensitive; an unknown value fell back to `legacy`
  with a warning (startup did not stop).

So no new storage, IPC channel, engine abstraction or migration was needed: the engines
become two ordinary settings, and main passes the effective setting to the existing
`readFlag` hooks.

## 2. Files changed

| File                                                                 | Change                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/settings.ts`                                    | New category `engines` ("Agent Engines"); `EngineChoiceSchema` (`legacy` \| `adk`); settings `engine.chat` (env `AGENT_ENGINE`, applies immediately) and `engine.research` (env `RESEARCH_ENGINE`, applies to new tasks), both built-in `legacy`; optional `description` on select options. |
| `apps/desktop/src/main/config/runtime-config.ts`                     | Environment layer reads `AGENT_ENGINE` / `RESEARCH_ENGINE` with the previous lenient rules (trim, case-insensitive; unknown → warning, `legacy`).                                                                                                                                           |
| `apps/desktop/src/main/index.ts`                                     | Chat: `readFlag: () => config.getSettings()['engine.chat']`. Research: `researchTaskModelsFor(…, { readFlag: () => config.getSettings()['engine.research'] })`.                                                                                                                             |
| `apps/desktop/src/main/chat-engine.ts`                               | `createAppChatEngines` accepts an optional `readFlag` (default: env, as before); doc comment; ADK-unavailable message points to Settings.                                                                                                                                                   |
| `apps/desktop/src/main/research-engine.ts`                           | Doc comment; ADK-unavailable message points to Settings.                                                                                                                                                                                                                                    |
| `apps/desktop/src/renderer/src/components/settings/EnginesPanel.vue` | New panel: the existing `SettingsForm` (select, source badge, Save/Reset) plus each option's explanation and an **Active** marker.                                                                                                                                                          |
| `apps/desktop/src/renderer/src/pages/SettingsPage.vue`               | Agent Engines category.                                                                                                                                                                                                                                                                     |
| `apps/desktop/src/renderer/src/lib/settings.ts`                      | `optionsWithActive(view, key)` helper.                                                                                                                                                                                                                                                      |
| Tests                                                                | `main/config/engine-settings.test.ts` (new), `renderer/src/lib/engines.test.ts` (new), Phase 7.4.2 blocks in `main/chat-engine.integration.test.ts` and `main/research-engine.integration.test.ts` (harness option `settingsEnv` uses a real `RuntimeConfig` on the same database).         |
| Docs                                                                 | `docs/settings.md` (Agent Engines section), `README.md`, `.env.example`.                                                                                                                                                                                                                    |

Unchanged: Ollama transport, Research step machine, engine pinning format, migrations,
tool permissions, IPC contract shape (the settings view carries the two new keys
automatically), defaults (`legacy`/`legacy`). No autonomous tools, no persistent ADK sessions.

## 3. Persistence and precedence

- Stored as `settings.engine.chat` / `settings.engine.research` rows in the existing
  `settings` table (no migration). Databases without these rows load the defaults.
- **Precedence:** built-in `legacy` < `AGENT_ENGINE` / `RESEARCH_ENGINE` < value saved in
  Settings. The Settings page shows the source (Default / Environment / Customized); **Reset**
  removes the saved value and returns to the environment value or `legacy`.
- **Validation:** the Settings value must be exactly `legacy` or `adk` (Zod enum); anything
  else is rejected and nothing is saved. Environment values keep the earlier lenient
  behaviour (case-insensitive; unknown → warning + `legacy`). A corrupted saved row is
  ignored with a warning.
- No restart needed: the setting is read when it is used.

## 4. Engine switching

- **Chat:** `ChatController.start` asks the selector for an engine; the selector reads
  `engine.chat` from the effective settings. A reply already streaming keeps its engine and
  can be cancelled as before; the next message uses the saved choice. Selection changes are
  logged (`Chat engine: adk`).
- **Research:** `capture()` reads `engine.research` once when a task is created and pins it
  (ADK tasks store `researchEngine: "adk"`; legacy tasks store nothing new). Pause/Resume,
  Retry and crash recovery use the pin; changing Settings never moves an existing task.

## 5. Test results

| Check                               | Result                                      |
| ----------------------------------- | ------------------------------------------- |
| `pnpm typecheck`                    | pass                                        |
| `pnpm lint`                         | pass                                        |
| `pnpm format:check`                 | pass                                        |
| `pnpm test`                         | 75 files, **1003 tests passed** (was 979)   |
| `pnpm build`                        | pass                                        |
| Inference / live tests / benchmarks | not run (fake Ollama server and mocks only) |

New coverage: default legacy (config, Chat, Research); independent persistence of both
choices and reload after reopening the database; strict rejection of invalid values
(nothing saved); environment defaults, case-insensitivity, saved-wins and Reset; unknown
env values; corrupted saved rows; pre-7.4.2 databases; change events; Chat switching for
the next request without restart while a running reply keeps its engine; cancellation on
both engines after switching; Research pin at creation; paused task resumed on its engine
after a Settings change (input unchanged); crash recovery in both directions after the
saved choice was changed; Retry keeping the ADK engine; renderer options with explanations
and the active marker. All existing Legacy/ADK parity tests pass unchanged (the only
existing expectation changed is the wording of the "ADK chat engine could not be
started" message).

## 6. Remaining risks

- A user can now enable ADK from the UI. ADK paths are the ones tested in Phases 6–7;
  only fake-server tests were run here.
- **Behaviour change:** before, `AGENT_ENGINE` / `RESEARCH_ENGINE` were the only source.
  A value saved in Settings now overrides them; an operator who sets the variable while a
  user has saved a choice will see the saved choice (the Settings page marks it
  "Customized"; Reset restores the variable).
- Settings validation is strict (`ADK` is rejected) while the environment is lenient — by
  design for backward compatibility.
- The ADK runtime is still loaded lazily on first use; the first ADK request after
  switching can be slower (see Phase 7.2.1).
- No UI shows which engine a given Research task uses; it is stored with the task only.
