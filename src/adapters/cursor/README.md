# Cursor IDE Adapter

Cursor local IDE integration for **memory-tencentdb** (Linux / macOS).
This adapter translates Cursor Hooks into Gateway `/capture` traffic and
exposes two read-only MCP search tools. It does **not** embed OpenClaw.

**Related:** issue [#235](https://github.com/TencentCloud/TencentDB-Agent-Memory/issues/235);
complementary to PR [#316](https://github.com/TencentCloud/TencentDB-Agent-Memory/pull/316)
(`GatewayMemoryClient`). v1 uses a thin native `fetch` wrapper with the same
Bearer/JSON routes; it does **not** require #316 to merge.

## Architecture

```text
Cursor IDE (top-level interactive session)
  sessionStart → marker + L3/L2 additional_context
  stop         → read last transcript turn → pending JSONL → detached one-shot
  sessionEnd   → detached one-shot (+ best-effort /session/end)
        |
        v
gatewayRequest (thin native fetch)  ──compatible with──►  #316 GatewayMemoryClient
        |
        v
TDAI Gateway HTTP (:8420)
        |
        v
StandaloneHostAdapter → TdaiCore
```

| Host event | Adapter behavior | Gateway route |
| --- | --- | --- |
| `sessionStart` (`is_background_agent === false`) | Write top-level marker; inject L3/L2 + tool guide | — |
| `stop` (marker present) | Append folded user/assistant/stop pending; spawn worker | `POST /capture` |
| `sessionEnd` | Spawn worker; clear marker | `POST /session/end` (best-effort) |
| MCP tools | `tdai_memory_search` / `tdai_conversation_search` | `POST /search/*` |

Foreground Hooks never perform HTTP, Gateway start, health checks, or full
pending scans. Delivery uses a short-lived detached worker plus a global
`proper-lockfile` lock.

## Install

From this repository (Node.js `>=22.16.0`):

```bash
npm install
npm run build   # produces dist/cursor.mjs
npx memory-tencentdb-cursor install --scope project   # or --scope user
```

The installer merges Hooks / MCP / Rule with ownership marker
`tencentdb-memory-cursor-v1` and refuses dual-scope duplicates.

Uninstall:

```bash
npx memory-tencentdb-cursor uninstall --scope project
```

Point at a running TDAI Gateway (`MEMORY_TENCENTDB_GATEWAY_URL`, default
`http://127.0.0.1:8420`). The worker may start Gateway lazily via
`scripts/memory-tencentdb-ctl.sh` when complete pending exists.

## Capture contract

```text
user_content
assistant_content
session_key = cursor:<conversation_id>
```

HTTP `2xx` is the only ACK (including `l0_recorded = 0`).

## Open gates

Hook timeout defaults and real Background Agent lifecycle are not closed yet;
this adapter does not claim production release acceptance until they are.

## Tests

```bash
npx vitest run src/adapters/cursor
```
