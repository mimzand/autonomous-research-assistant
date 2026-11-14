# Agent Process Separation Plan

Full process separation: a **standalone Node agent service** owns the agent graph and
SQLite; the Electron app becomes a **UI shell** that talks to it over a local protocol.
Agents can run **without** Electron.

**Status:** planning only — implement phase-by-phase using the Claude prompts below.
**Prerequisite:** logical package separation is complete (`@rka/agent-host`,
`docs/agent-host-separation-plan.md`, Phase 5).

**Locked decisions**

| Decision | Choice |
| -------- | ------ |
| Runtime model | **B — separate Node service** (`apps/agent`), runnable without Electron |
| SQLite ownership | **A — agent process owns the DB** (single writer); Electron never opens SQLite |
| Not chosen | Electron `utilityProcess` as the primary model (may still be a later packaging option that speaks the same protocol) |

---

## 1. Goal

```text
Today (after host separation)
  Renderer → preload → Electron main
                           └── createAgentHost (in-process) → SQLite / Ollama / tools

Target
  Renderer → preload → Electron main (shell only)
                           └── AgentClient  ===local protocol===  Agent service
                                                                    ├── createAgentHost
                                                                    ├── SQLite (sole owner)
                                                                    ├── Ollama provider
                                                                    └── tools / engines

  Also:  node apps/agent  (or pnpm agent:dev)  → same service, no Electron
```

**Electron owns:** window, session/CSP, preload, renderer IPC, native dialogs/shell,
`safeStorage` for secrets at rest, starting/stopping the agent (when packaged), UI for
settings.

**Agent owns:** SQLite, research step machine, ChatController, engines, tools, Ollama
HTTP client, all durable task/source/report state.

**Shared:** Zod protocol contracts (new package), domain DTOs already in `@rka/shared`.

---

## 2. Why not utilityProcess-only

You chose a service that can run **independently** of Electron (dev, CI, headless smoke).
`utilityProcess` stays optional later as an alternate supervisor that speaks the **same**
protocol. Do not design two protocols.

---

## 3. Hard constraints (every phase)

1. **Ollama only** — no cloud LLM APIs; do not exfiltrate prompts/docs to cloud models.
2. **Single SQLite writer** — only the agent process opens `better-sqlite3`. Electron must
   not call `openAppStorage` / `openStorage` in production after cutover.
3. **Renderer isolation unchanged** — sandboxed; preload = frozen `window.api`; Zod IPC;
   renderer still talks only to Electron, never to the agent port directly.
4. **Local protocol only** — bind loopback (or a private named pipe). No remote agent
   listen by default. Authenticate every session (shared secret / token).
5. **Zod-validate** every request, response, and event on the agent protocol.
6. **Shell ports stay in Electron** — `chooseFile`, `chooseBackupPath`, `chooseFolder`,
   `openExternal`, UI fan-out. Agent calls them via **reverse RPC** when needed.
7. **Secrets** — encrypt with `safeStorage` in Electron; deliver decrypted values to the
   agent only over the authenticated local channel; never log them; never send to renderer.
8. **Security guards** — today forbid `child_process` / `spawn` / `fork` in shipped app
   code. This plan needs a **narrow, deliberate exception**: Electron may spawn/supervise
   **only** the known agent entry (allow-listed path). Agent tools still must not get a
   shell. Update `docs/security.md` and `security-guards.test.ts` in the packaging phase.
9. **No process split half-measures** — do not leave a dual-write DB path in production.
10. Follow `CLAUDE.md`. After meaningful changes: typecheck, lint, test, build (and
    `pnpm check` on the final phase).
11. Write a phase report (`docs/agent-process-separation-phaseN-report.md`) using §8.

---

## 4. Target packages / apps

| Piece | Role |
| ----- | ---- |
| `packages/agent-protocol` (new) | Transport-agnostic Zod schemas: requests, responses, events, handshake, error codes. No Electron, no SQLite. |
| `packages/agent-host` (existing) | Still the composition root inside the agent process. Evolve ports to support async reverse shell calls. |
| `apps/agent` (new) | Node entry: load settings, open storage, create provider/web/host, serve protocol. Scripts: `agent:dev`, `agent:start`. |
| `apps/desktop` | Shell: `AgentClient`, proxy existing Electron IPC → protocol, HostPorts reverse handlers, optional process supervisor. |
| `@rka/shared` | Keep renderer↔Electron IPC stable. Prefer putting **agent↔shell** contracts in `agent-protocol`, reusing shared domain schemas. |

### Suggested dependency DAG

```text
@rka/shared
    ▲
agent-protocol
    ▲
agent-host (uses protocol types for reverse ports / envelope helpers as needed)
    ▲
apps/agent          apps/desktop (AgentClient only; no createAgentHost in production)
```

---

## 5. Protocol sketch (normative intent; Phase 0 freezes schemas)

**Transport (default):** TCP `127.0.0.1` with an ephemeral port + handshake.

- Agent writes `{ port, token, pid, startedAt }` to a lock/state file under the app
  user-data dir (or a path passed by CLI), with restrictive file ACL when possible.
- Client connects, sends `hello` with token; server rejects mismatch.
- Framing: length-prefixed JSON UTF-8 (or NDJSON if Phase 0 justifies — pick one and stick).

**Directions**

| Direction | Examples |
| --------- | -------- |
| Shell → Agent | `chat.start`, `chat.stop`, `tasks.*`, `sources.*`, `reports.*`, `storage.*`, `researchTools.*`, `settings.apply`, `model.health`, `shutdown` |
| Agent → Shell (reverse) | `ui.researchProgress`, `ui.settingsChanged` (if agent emits), `shell.chooseBackupPath`, `shell.chooseFile`, `shell.chooseFolder`, `shell.openExternal`, `shell.getSecret` |
| Agent → Shell (push) | Chat stream events (`chat.event`), research progress |

**Reuse:** map almost 1:1 from existing `@rka/shared` IPC payloads (`ChatEvent`,
`StartResearchRequest`, dashboard DTOs, settings view/patch). Do **not** invent parallel
domain shapes.

**Streaming:** Chat keeps a `streamId`; events are push messages. Cancellation is
`chat.stop` with the same id (same semantics as today).

---

## 6. Ownership after cutover

| Concern | Owner |
| ------- | ----- |
| SQLite file under userData | Agent |
| Migrations / recovery on open | Agent |
| Ollama HTTP + auth token use | Agent (token supplied by shell or loaded via reverse `getSecret`) |
| SearXNG / web tool config | Agent (settings applied over protocol) |
| `RuntimeConfig` persistence | Prefer agent-owned settings rows already in SQLite; Electron Settings UI becomes a protocol client |
| `safeStorage` encrypt/decrypt | Electron only |
| Native dialogs / `openExternal` | Electron (reverse RPC) |
| Window / preload / renderer IPC | Electron |
| Process lifecycle (packaged) | Electron supervises agent child; standalone mode has no supervisor |

---

## 7. Phases overview

| Phase | Name | Outcome |
| ----- | ---- | ------- |
| **0** | Protocol package + threat model | `@rka/agent-protocol` schemas; security note; no runtime cutover |
| **1** | Agent app scaffold + loopback server | `apps/agent` boots, handshake works, health ping |
| **2** | Electron AgentClient + dual-mode flag | Shell can talk to agent; still may run in-process behind a flag |
| **3** | Storage cutover | Agent opens DB; dashboard/storage/tasks read/write via protocol |
| **4** | Chat over protocol | Stream/stop/usage via protocol; in-process chat path optional behind flag |
| **5** | Research + progress | Lifecycle + push events; reverse not yet required beyond UI emit |
| **6** | Reverse shell ports | Dialogs / openExternal / secrets over reverse RPC; Research Tools complete |
| **7** | Settings + provider in agent | Live settings apply on agent; Electron keeps safeStorage + UI |
| **8** | Supervise + package + standalone | Spawn allow-list, `pnpm agent:dev`, packaged layout, cut in-process host from prod |
| **9** | Acceptance | Thin Electron, single writer, security docs/guards, `pnpm check`, smoke |

**Rule:** do not start phase *N+1* until phase *N* report is reviewed.

**Feature flag:** until Phase 8 cutover, prefer `AGENT_TRANSPORT=inprocess|service`
(or equivalent) so development can roll back. Production default becomes `service` at
Phase 8.

---

## 8. Phase report template

Each phase writes `docs/agent-process-separation-phaseN-report.md`:

```markdown
# Agent Process Separation — Phase N Report

## Summary
- Status: complete | blocked | partial
- One-paragraph outcome

## Changes
- Files added / moved / deleted
- Protocol / public API changes

## Boundaries
- Who opens SQLite?
- Can renderer reach the agent port?
- child_process / spawn allow-list status
- electron imports in agent packages?

## Checks run
- typecheck / lint / test / build (/ check)

## Behaviour
- Intentional changes?
- Flag defaults (`inprocess` vs `service`)?

## Risks / decisions
- Deviations from this plan and why
```

---

## 9. Phase details + Claude prompts

---

### Phase 0 — Protocol + threat model

**Goal:** Freeze the agent↔shell contract in code (schemas) and document security.

**In scope**

- Create `packages/agent-protocol` (mirror sibling packages).
- Zod envelopes: `Request`, `Response`, `Event`, handshake, error codes.
- First vertical slice of methods as **typed stubs** (even if not all implemented): at
  least `system.ping`, `system.hello`, plus placeholders or full schemas for chat/tasks
  aligned with `@rka/shared`.
- Doc section in this file or `docs/agent-process-security.md`: loopback-only, token file,
  no renderer access, spawn allow-list intent, secrets handling.
- Wire workspace + ESLint (renderer/preload must not import agent-protocol if it could
  encourage bypassing preload — **prefer** only main + apps/agent import it; or allow
  shared types only carefully).

**Out of scope:** running the service; moving SQLite; Electron client.

#### Claude prompt — Phase 0

```text
You are the senior engineer for this monorepo (see CLAUDE.md).

## Task
Implement **Agent Process Separation Phase 0 only**: create `@rka/agent-protocol` and document the security model for a standalone Node agent service. Do NOT implement the agent server, Electron client, SQLite move, or process spawn yet.

## Context
- Logical host separation is done: `@rka/agent-host` + `createAgentHost`; Electron is already a thin in-process shell.
- Master plan: docs/agent-process-separation-plan.md
- Locked decisions: separate Node service (apps/agent later); agent process owns SQLite; Electron never opens DB after cutover; renderer never talks to the agent port.

## Deliverables
1. packages/agent-protocol — package.json, tsconfig, vitest, src/index.ts
2. Zod schemas for:
   - Handshake hello/ack with token
   - Envelope: id, kind (req|res|event|error), method, payload
   - system.ping / system.hello
   - Sketch method names for chat.*, tasks.*, sources.*, reports.*, storage.*, researchTools.*, settings.*, model.*, shell.* (reverse) — full payload schemas may reuse @rka/shared types via z.lazy or imported schemas where practical
3. Unit tests for parse/reject of envelopes and handshake
4. docs/agent-process-security.md covering: loopback bind, token file, single DB writer, secrets, spawn allow-list intent, renderer isolation preserved
5. README DAG mention (short)
6. docs/agent-process-separation-phase0-report.md (§8 template in the plan)

## Constraints
- Ollama only; no electron in packages; single package entry; no unrelated refactors.
- Do not change runtime behaviour of the desktop app in this phase.
- Prefer reusing @rka/shared domain Zod schemas over duplicating DTOs.

## Definition of Done
pnpm typecheck, lint, test, build pass. Report written.
```

---

### Phase 1 — `apps/agent` scaffold + loopback server

**Goal:** Standalone process that serves handshake + ping.

**In scope**

- `apps/agent` entry (tsx/node), CLI args: `--data-dir`, `--token` / token file path, `--port 0`.
- Minimal server using agent-protocol framing.
- Does **not** open SQLite yet (or opens only if unavoidable — prefer not).
- Script `pnpm agent:dev` from root.
- Tests with a real TCP connect on 127.0.0.1.

**Out of scope:** Electron integration; createAgentHost wiring; production spawn.

#### Claude prompt — Phase 1

```text
You are the senior engineer for this monorepo (see CLAUDE.md).

## Task
Implement **Agent Process Separation Phase 1 only**: scaffold `apps/agent` with a loopback server that speaks `@rka/agent-protocol` handshake + system.ping. Do NOT wire createAgentHost, SQLite, or Electron yet.

## Prerequisites
Phase 0 done. Read docs/agent-process-separation-plan.md and phase0 report/security doc.

## Deliverables
- apps/agent package with start entry
- Bind 127.0.0.1 only; ephemeral port support
- Write connection state file { port, token, pid } when started (path configurable)
- Reject bad tokens
- Root script alias (e.g. pnpm agent:dev)
- Tests for happy-path ping and auth failure
- phase1 report

## Constraints
- No electron; Ollama only; no DB ownership yet; no child_process in agent tools.
- Keep the server small and testable.

## Definition of Done
Standalone `pnpm agent:dev` (or documented command) accepts a client handshake+ping. Checks pass. Report written.
```

---

### Phase 2 — Electron `AgentClient` + transport flag

**Goal:** Electron can connect to a running agent; default remains in-process.

**In scope**

- `AgentClient` in desktop main (or small package used by desktop).
- Feature flag `AGENT_TRANSPORT=inprocess|service` (default `inprocess`).
- When `service`: connect using state file / env; fail startup clearly if unreachable.
- Proxy **one** cheap call end-to-end for proof (e.g. model health OR system.ping surfaced in logs / app info). Do not cut SQLite yet.

**Out of scope:** Moving DB; removing createAgentHost.

#### Claude prompt — Phase 2

```text
You are the senior engineer for this monorepo (see CLAUDE.md).

## Task
Implement **Agent Process Separation Phase 2 only**: add Electron AgentClient and AGENT_TRANSPORT=inprocess|service flag (default inprocess). Prove connectivity with handshake+ping (or one read-only RPC). Do NOT move SQLite or remove createAgentHost.

## Prerequisites
Phases 0–1 done.

## Deliverables
- AgentClient (connect, request/response, reconnect policy minimal/clear)
- Flag plumbing in desktop main/env
- When service: read agent state file, connect loopback, authenticate
- Clear user-visible/log error if service mode and agent down
- Tests for client framing/auth against apps/agent or a fake server
- phase2 report

## Constraints
- Renderer still does not talk to agent.
- Default transport remains inprocess so existing users/tests keep working.
- No protocol redesign.

## Definition of Done
Manual: start apps/agent, run desktop with AGENT_TRANSPORT=service, see successful ping. Checks pass. Report written.
```

---

### Phase 3 — Storage cutover (agent owns SQLite)

**Goal:** In `service` mode, only the agent opens the DB; Electron proxies dashboard/storage/tasks reads & writes.

**In scope**

- Agent boots storage (migrations, recovery) via createAgentHost or a slimmer bootstrap.
- Implement protocol methods for tasks/sources/reports/storage used by dashboard IPC.
- Electron IPC handlers in service mode call AgentClient instead of local Storage.
- Inprocess mode unchanged.
- Integration tests for protocol dashboard surface.

**Out of scope:** Chat streaming; Research Tools dialogs; killing inprocess.

#### Claude prompt — Phase 3

```text
You are the senior engineer for this monorepo (see CLAUDE.md).

## Task
Implement **Agent Process Separation Phase 3 only**: in AGENT_TRANSPORT=service, the agent process is the sole SQLite owner; Electron proxies dashboard/tasks/sources/reports/storage IPC through AgentClient. Keep inprocess mode working.

## Prerequisites
Phases 0–2 done. createAgentHost already exists in @rka/agent-host.

## Design
- apps/agent opens storage with the same userData path convention Electron used (pass --data-dir).
- Wire enough of createAgentHost (or equivalent) to serve dashboard/task APIs.
- Electron must NOT open SQLite when transport=service (assert in code + test).
- Reuse @rka/shared DTO Zod schemas in protocol payloads.

## Constraints
- Single writer; no dual-open.
- Recovery on agent open; log interrupted tasks as today.
- Ollama wiring may still be partial if needed for host construction — prefer real provider with settings from env/file; document gaps for Phase 7.
- No renderer protocol access.

## Definition of Done
service mode: task list/get/start-research (or the subset you implement — prefer full dashboard parity) works against agent DB. inprocess still works. Checks pass. phase3 report.
```

---

### Phase 4 — Chat over protocol

**Goal:** Chat start/stop/events work in service mode.

**In scope**

- Protocol chat.start / chat.stop / chat.event push.
- Electron Chat IPC proxies to agent; map sinks to renderer as today.
- Usage recording: prefer agent writes model_usage to SQLite (it owns DB); drop or adapt desktop `chatUsageRecorder` in service mode.

**Out of scope:** Research Tools reverse dialogs.

#### Claude prompt — Phase 4

```text
You are the senior engineer for this monorepo (see CLAUDE.md).

## Task
Implement **Agent Process Separation Phase 4 only**: Chat start/stop/streaming over the agent protocol in service mode. Keep inprocess Chat path working.

## Prerequisites
Phases 0–3 done (agent owns DB in service mode).

## Design
- Preserve ChatEvent / busy / stop semantics from ChatController.
- Push events shell→renderer unchanged (Electron still owns webContents).
- Usage persistence goes to SQLite inside the agent process in service mode.
- Tests: protocol-level chat with fake model provider if possible; desktop ipc test with fake agent client optional.

## Constraints
- No electron in agent; Ollama only; Zod everywhere.
- Do not expose agent TCP to renderer.

## Definition of Done
service mode chat works end-to-end against a fake or real Ollama. Checks pass. phase4 report.
```

---

### Phase 5 — Research lifecycle + progress

**Goal:** Research start/pause/resume/cancel/retry + progress events in service mode.

**In scope**

- Protocol methods mirroring tasks.* research actions.
- Progress push → Electron → renderer (`research:progress`).
- Engine pinning / recovery semantics unchanged (code still in agent-runtime).

#### Claude prompt — Phase 5

```text
You are the senior engineer for this monorepo (see CLAUDE.md).

## Task
Implement **Agent Process Separation Phase 5 only**: Research task lifecycle and progress events over the agent protocol in service mode.

## Prerequisites
Phases 0–4 done.

## Design
- Map existing runtime.tasks.* and onResearchEvent through protocol events.
- Electron fan-out to BrowserWindows stays in the shell.
- Preserve pause/resume/cancel/retry and interrupted recovery behaviour.

## Constraints
- Same as plan §3. inprocess mode remains available.
- No reverse dialogs required unless backup is in this phase — backup may wait for Phase 6 if it needs chooseBackupPath.

## Definition of Done
service mode can start and observe a research task (fake tools/provider acceptable in tests). Checks pass. phase5 report.
```

---

### Phase 6 — Reverse shell ports

**Goal:** Agent can request dialogs / openExternal / secrets from Electron.

**In scope**

- Reverse RPC methods: chooseBackupPath, chooseFile, chooseFolder, openExternal, getSecret, encryptionAvailable.
- Adapt `HostPorts` implementations: in agent process, ports are protocol stubs; Electron registers handlers.
- Research Tools + storage backup in service mode.
- Timeouts and cancel-on-disconnect behaviour documented and tested.

#### Claude prompt — Phase 6

```text
You are the senior engineer for this monorepo (see CLAUDE.md).

## Task
Implement **Agent Process Separation Phase 6 only**: reverse RPC for shell ports (dialogs, openExternal, secrets) so Research Tools and backup work in service mode.

## Prerequisites
Phases 0–5 done. HostPorts already exist on @rka/agent-host.

## Design
- Agent-side HostPorts call the shell over the protocol and wait for results.
- Electron-side handlers use existing host-ports.ts / safeStorage logic.
- Keep double-check openExternal safety (service + Electron).
- Paths still never cross renderer IPC (tokens only) — same Research Tools guarantees.

## Constraints
- Secrets never logged; only over authenticated local channel.
- If shell disconnects mid-dialog, agent fails the operation safely.

## Definition of Done
service mode: pick/extract file, openExternal, backup path selection work. Checks pass. phase6 report.
```

---

### Phase 7 — Settings + provider live in agent

**Goal:** Settings apply on the agent; Electron UI is a client; tokens via reverse secret port.

**In scope**

- Move effective runtime apply (Ollama reconfigure, web reconfigure, engine flags) into agent.
- Electron SettingsService talks protocol for get/validate/update; setSecret still encrypts in Electron then pushes or stores via agent as designed (document choice).
- Disconnect/connect session flags behaviour preserved.

**Recommendation:** persist settings in SQLite (already partially true); Electron `safeStorage` wraps secret ciphertext stored in DB **or** keeps ciphertext local and only sends plaintext to agent memory after unlock — pick one in the phase report and stick to it.

#### Claude prompt — Phase 7

```text
You are the senior engineer for this monorepo (see CLAUDE.md).

## Task
Implement **Agent Process Separation Phase 7 only**: settings and live Ollama/web reconfiguration owned by the agent in service mode; Electron Settings UI becomes a protocol client; secrets still use safeStorage in Electron.

## Prerequisites
Phases 0–6 done (reverse getSecret available).

## Design
- Decide and document secret persistence shape (ciphertext in SQLite vs Electron-only ciphertext).
- Apply settings without restart (same UX as today).
- inprocess mode may keep current RuntimeConfig path OR share code — avoid huge duplication if a small shared module helps; no drive-by rewrite of unrelated UI.

## Constraints
- Ollama only; token never to renderer; HTTPS/loopback rules unchanged.
- Single DB writer remains the agent in service mode.

## Definition of Done
service mode: change model/base URL/web search settings and see them apply on next chat/research. Checks pass. phase7 report.
```

---

### Phase 8 — Supervise, package, standalone cutover

**Goal:** Electron can spawn the agent; packaged app works; production default = service; remove production in-process host path.

**In scope**

- Narrow spawn allow-list for the agent entry (update security.md + security-guards).
- Packaged layout: ship agent entry + `better-sqlite3` for **Node** ABI used by agent (document Electron vs Node binary strategy — may need separate native build or run agent with Electron's node / noted approach).
- `AGENT_TRANSPORT` default `service` for packaged builds; dev may keep override.
- Remove production `createAgentHost` from Electron main path (tests may still use host package directly).
- Standalone: `pnpm agent:dev` usable without Electron for smoke.

**Critical packaging note:** `better-sqlite3` must load in the **agent** Node runtime. Decide explicitly: (a) agent runs under Electron's utility/helper node, (b) ship a node binary, or (c) use a JS driver — **prefer (a) or dedicated node** with an evidenced choice in the report. Do not silently break native addons.

#### Claude prompt — Phase 8

```text
You are the senior engineer for this monorepo (see CLAUDE.md).

## Task
Implement **Agent Process Separation Phase 8 only**: Electron supervises the agent process, packaging works, production cuts over to service transport, and security docs/guards gain a narrow spawn allow-list. Preserve standalone agent:dev.

## Prerequisites
Phases 0–7 done.

## Design
- Allow-list only the known agent entry path/args; never shell out to user strings.
- Packaged app starts agent before accepting UI calls that need it; shutdown agent on quit.
- Default transport=service for packaged builds.
- Remove production in-process createAgentHost wiring from Electron index.ts.
- Update docs/security.md, docs/release.md, docs/user-guide.md as needed.
- Prove better-sqlite3 loads in the agent runtime you chose; document it.

## Constraints
- Renderer isolation unchanged.
- No remote listen.
- Ollama only.
- Update security-guards tests accordingly (spawn allowed only in the supervisor module).

## Definition of Done
Packaged or package:dir smoke path documented; standalone agent works; production code path is service-only. Checks pass. phase8 report.
```

---

### Phase 9 — Acceptance

**Goal:** Final checklist and `pnpm check`.

#### Claude prompt — Phase 9

```text
You are the senior engineer for this monorepo (see CLAUDE.md).

## Task
Implement **Agent Process Separation Phase 9 only**: acceptance audit, doc status, full pnpm check. No features.

## Checklist (evidence in report)
- [ ] Electron production does not open SQLite
- [ ] Agent is sole DB writer in service/packaged mode
- [ ] Renderer cannot connect to agent port (CSP + no API)
- [ ] Protocol authenticated on loopback
- [ ] Reverse ports work for dialogs/secrets
- [ ] createAgentHost not used from Electron production bootstrap
- [ ] security.md describes spawn allow-list and process model
- [ ] Standalone agent:dev documented
- [ ] Process separation IS done (unlike the earlier host-only plan)
- [ ] pnpm check passes

Update docs/agent-process-separation-plan.md status to Phase 9 complete.
Write docs/agent-process-separation-phase9-report.md.
```

---

## 10. Risks (read before Phase 8)

1. **Native module ABI** — Electron and Node often need different `better-sqlite3` builds.
2. **Crash isolation** — agent crash must not corrupt DB (SQLite journaling); Electron should show recovery UI and restart policy.
3. **Handshake file races** — stale PID/port files after crash; include pid liveness check.
4. **Settings split-brain** — until Phase 7, env flags can drift between processes; keep one settings authority.
5. **Test drift** — desktop integration tests that open SQLite locally must run against agent or stay explicitly inprocess-only.
6. **Performance** — chat token streaming over TCP is fine locally; avoid huge synchronous payloads (paginate lists as today).

---

## 11. Human workflow

1. Paste Phase 0 prompt → review `phase0-report.md`
2. Paste report into planning chat → unlock next phase
3. Repeat through Phase 9

After Phase 9: new agent behaviour goes in `apps/agent` / `@rka/agent-host`; Electron only gains shell/UX/protocol client code.

---

## 12. Relation to prior plan

| Plan | Result |
| ---- | ------ |
| `docs/agent-host-separation-plan.md` | Logical package split — **done** (in-process) |
| `docs/agent-process-separation-plan.md` (this file) | Process + standalone service — **to do** |

The host separation is a prerequisite, not a substitute.
