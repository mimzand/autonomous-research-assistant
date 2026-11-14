# Phase 7.4.1 — Ollama connection label in the Chat header

## Root cause

`apps/desktop/src/renderer/src/components/ChatPanel.vue` hardcoded the suffix
`· local via Ollama`. Nothing was derived; the label was wrong for every non-loopback
server. The same component's empty-chat hint also hardcoded "Everything stays on this
computer."

Secondary issue found while tracing the update path: `useModelHealth.refresh()` returned
early when a health check was already running. A Settings save during a running check
(likely with a slow remote) was dropped, so the header could stay stale until the next
30 s poll.

The data needed was already there: `ModelHealth.baseUrl` is the provider's effective
`config.baseUrl` (main process; Settings applies the new config before broadcasting
`settings:changed`), and the renderer already re-checks health on any `ollama.*` change.

## Changes

| File                                                               | Change                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/settings.ts`                                  | `ollamaConnectionLabel(baseUrl)`: reuses `classifyHost` (the same classification as `connectionAdvice`, `violatesHttpsPolicy`, `canSendCredentials`). Loopback → `Local Ollama`; anything else (HTTPS or plain HTTP allowed by policy) → `Remote Ollama`; unparsable → `Ollama`. |
| `apps/desktop/src/renderer/src/components/ChatPanel.vue`           | Header shows `· {{ connectionLabel }}` derived from `health.baseUrl` (`Ollama` until the first check). Empty-chat hint no longer claims "stays on this computer" for a remote server.                                                                                            |
| `apps/desktop/src/renderer/src/composables/useModelHealth.ts`      | A refresh requested during a running check now runs one more check afterwards instead of being dropped.                                                                                                                                                                          |
| `packages/shared/src/connection-label.test.ts`                     | New: 11 classification cases.                                                                                                                                                                                                                                                    |
| `apps/desktop/src/renderer/src/composables/useModelHealth.test.ts` | New: local label; Settings change local → remote → local without restart; save during a running check (fails on the old code, passes now).                                                                                                                                       |

Not changed: Ollama transport, authentication, IPC contract (no new channel or field),
model selection, Legacy/ADK engines and defaults, preload, main process.

## Results

| Check                               | Result                                   |
| ----------------------------------- | ---------------------------------------- |
| `pnpm typecheck`                    | pass                                     |
| `pnpm lint`                         | pass                                     |
| `pnpm format:check`                 | pass                                     |
| `pnpm test`                         | 73 files, **979 tests passed** (was 965) |
| `pnpm build`                        | pass                                     |
| Inference / live tests / benchmarks | not run                                  |

## Manual check

Settings → Ollama Connection: save `https://<tunnel>.ngrok-free.dev` → Chat header shows
`qwen3.5:9b-mlx · Remote Ollama` after the health check (no restart). Save
`http://127.0.0.1:11434` → `· Local Ollama`.
