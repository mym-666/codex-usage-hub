# Architecture

Usage Hub is a Codex plugin with four moving parts: an MCP server that Codex owns, a background
helper that builds the data snapshot, a WinForms overlay, and an optional Edge extension that
bridges the provider website.

## Components

| Path | Role |
| --- | --- |
| `mcp/server.mjs` | MCP stdio server. Exposes `usage_snapshot`, `usage_runtime_status`, `usage_overlay_control`; starts the overlay, keeps a watchdog and an ownership heartbeat, and owns `snapshot.json` refreshes triggered by tool calls |
| `runtime/usage-helper.mjs` | Snapshot builder and daemon. Reads Codex files and (optionally) CC Switch, probes the provider balance API, merges the web bill, writes `snapshot.json`, and runs the loopback receiver |
| `runtime/web-bill-server.mjs` | Loopback HTTP receiver on `127.0.0.1:32146`. Accepts `/web-bill`, `/web-balance`, `/web-bill-status`, serves `/health` and `/refresh-request`, and requires a token for `/shutdown` and `/request-refresh` |
| `runtime/codex-usage.mjs` | Incremental scanner for Codex rollout logs: today's token totals and the current thread, deduplicated by `response_id` and cached by byte offset |
| `runtime/usage-overlay.ps1` | The overlay window: expand/collapse, follow the Codex window, tray icon, font scaling, manual refresh, exit control |
| `runtime/providers/*.json` | Provider adapters: host/name matching, balance endpoints and field paths, website usage templates |
| `edge-extension/` | Manifest V3 bridge. Injects a page-world hook, parses usage responses, posts them to the loopback receiver, and keeps its own status for the popup |
| `scripts/start-mcp.ps1` | MCP launcher. Resolves `node.exe` from an allowlist of installation roots and refuses to execute anything else |
| `scripts/start-overlay.ps1` | Starts the overlay process hidden with the data directory, helper path and node path |
| `tests/*.test.mjs` | `node:test` suites, run through `tests/run-tests.ps1` |

## Data flow

```
Codex desktop app
  |  loads plugin
  v
mcp/server.mjs  --- starts --->  scripts/start-overlay.ps1 --->  usage-overlay.ps1
  |                                                                    ^
  |  spawns                                                            | reads
  v                                                                    |
runtime/usage-helper.mjs  -- writes snapshot.json ----------------------+
  |        ^
  |        |
  |        +-- ~/.codex/config.toml, auth.json, sessions/**/rollout-*.jsonl
  |        +-- ~/.cc-switch/cc-switch.db            (optional, read-only)
  |        +-- provider balance API                 (provider key)
  |        +-- web-bills.json / web-balance.json <-- web-bill-server.mjs <-- Edge extension
  |
  +-- Edge / Chrome Local Storage (in-memory fallback token, same-origin use only)
```

## Data sources and priority

| Displayed value | Priority order |
| --- | --- |
| Balance | Provider balance API (`provider-api`) -> provider website captured by the extension (`web-extension`, newer than 15 min) -> `--` |
| Today's cost | Web bill (`web` / `web-extension`) -> balance delta (`balance_delta`) -> CC Switch aggregate (`cc-switch`) |
| Today's tokens | Fresh web-bill tokens (`tokenScope = web`) -> Codex rollout logs (`tokenScope = codex`) |
| Current session | Codex rollout logs only (`session.source = codex-log`) |
| Provider identity | `~/.codex/config.toml` (`codex-config`) -> CC Switch row (`cc-switch`) |
| Model display name | CC Switch pricing row -> Codex model catalog (`model_catalog_json`) -> raw model id |
| Pricing | Adapter `pricing` table shipped with the plugin -> CC Switch `model_pricing` (only for models the adapter does not declare) |

Adapter selection is scored: host match > name match > category match, and a category-only match is
rejected when the adapter pins specific hosts. That prevents an unrelated provider from inheriting
another provider's endpoints.

Balance probes try every credential in order - plugin `config.json`, per-provider config, CC Switch
settings, Codex `auth.json` - and move on after 401/403. The Codex key is last on purpose: with a
local router it is often a proxy credential the provider does not accept.
## Runtime data directory

Everything the plugin persists lives in `%LOCALAPPDATA%\UsageHubPlugin`:

| File | Written by | Contents |
| --- | --- | --- |
| `snapshot.json` | helper / MCP server | The full snapshot the overlay and `usage_snapshot` read |
| `config.json` | user (optional) | Refresh interval, keys, browser order, adapter directories |
| `web-bills.json` | receiver | Per-provider web bills posted by the extension |
| `web-balance.json` | receiver | Balance captured from the provider website |
| `web-bill-status.json` | receiver | Last extension sync status (shown in the extension popup) |
| `codex-usage-cache.json` | helper | Byte offsets and per-response ids for the rollout scan |
| `state.json` | helper | Last balance sample used for the balance-delta estimate |
| `receiver-token.json` | receiver | Random token required by `/shutdown` and `/request-refresh` |
| `receiver-error.json` | receiver | Startup failure reported through `usage_runtime_status` |
| `overlay.pid`, `helper.pid`, `overlay-control.json`, `overlay-stopped.json` | overlay / MCP server | Lifecycle and remote control |
| `overlay-settings.json` | overlay | Font scale |
| `plugin.log` | all | Capped at 2 MB, tail kept, credentials redacted |
| `mcp-owners\*.json` | MCP server | One heartbeat per running MCP server; the overlay keeps the window alive while at least one owner is alive |

## Freshness rules

| Data | Stale after | Effect |
| --- | --- | --- |
| Web bill | 15 min | Marked `stale`, today's cost falls back to the balance delta, tokens fall back to Codex logs |
| Web balance | 15 min | Ignored, balance falls back to the provider API result |
| Current session | 15 min | The session row shows `--` |
| Receiver error | 60 min | Reported through `usage_runtime_status` |

## Security model

- The receiver binds loopback only and validates `Host`, `Origin` and `Sec-Fetch-Site` on every
  request. Pages cannot read its responses; `/shutdown` and `/request-refresh` additionally require
  a token from the data directory, which only the overlay reads.
- `/web-bill`, `/web-balance`, `/web-bill-status` and `/health` cannot be token-protected because an
  extension cannot read the plugin data directory. They are origin-gated instead and accept only
  blind writes with strict validation: provider names must match `[A-Za-z0-9._-]{1,64}`
  (prototype-polluting keys rejected), dates must be `YYYY-MM-DD`, costs must be non-negative,
  bodies are capped at 256 KB and debug payloads at 8 KB.
- Every URL that would carry an `Authorization` header must resolve to the provider's own host, its
  website host, a subdomain of either, the same registrable domain, or loopback for a local proxy.
  Keys are never interpolated into a URL.
- Adapters ship inside the plugin. Adapters from a writable directory are only loaded when
  `providersDirs` lists them, and their `balance.url` is dropped unless the adapter itself declares
  that host.
- `scripts/start-mcp.ps1` executes `node.exe` only from `CODEX_MCP_NODE_PATH`,
  `%ProgramFiles%\nodejs`, `%LOCALAPPDATA%\OpenAI\Codex\runtimes` or
  `%USERPROFILE%\.cache\codex-runtimes`, and requires major version 22 or newer.
- Web-bill text is treated as untrusted: it is sanitised, truncated to 120 characters and always
  carries `untrusted: true` so the agent quotes it instead of acting on it.

## Lifecycle

1. Codex loads the plugin and starts `scripts/start-mcp.ps1`, which runs `mcp/server.mjs`.
2. The server registers an owner heartbeat and creates the overlay through
   `scripts/start-overlay.ps1`; the watchdog re-checks every 15 s (the PID is cached in memory, so
   an idle thread does not re-read `overlay.pid` on every tick). The automatic start is staggered by
   `overlayStartDelaySeconds` (default 3 s) so it does not collide with Codex's own start-up;
   `usage_overlay_control` starts or restarts the overlay immediately. `overlayAutoStart: false`
   turns the automatic start off entirely. The overlay registers `overlay.pid`.
3. The overlay starts the helper if `helper.pid` is not alive; the helper refreshes the snapshot
   every 60 s by default and serves the loopback receiver. `snapshot.json` is only rewritten when the
   payload changed (a newer `updatedAt` alone is not a change), so a tick with no new data produces
   no writes.
4. The overlay polls `snapshot.json` every 5 s, repaints only when the file changed, caches the
   owner-heartbeat check for 2 s, sweeps stale owner records once a minute, throttles its DPI probe
   to once per 4 s and follows the Codex window position and visibility.
5. When Codex closes, the overlay hides and stays warm for `overlayIdleExitSeconds` (default
   300 s) so a later MCP server reuses it; after that it exits, stops the helper and removes its pid
   files. Choosing Exit in the menu sets a stop marker that suppresses restarts until the plugin
   reloads. Codex also terminates its process tree on exit, so warm reuse mainly covers thread churn
   rather than whole-app restarts.
6. With `overlayAutoStart: false` the plugin starts nothing at all, the watchdog respects it, and
   using the plugin (`usage_snapshot`) starts the managed overlay on demand.
   `scripts/overlay-standalone.ps1` (wrapped by `tools/start-usage-hub.cmd` /
   `tools/stop-usage-hub.cmd`) runs the overlay with `-Standalone`: no owner heartbeat is required,
   so the process outlives Codex and can be started or stopped on demand.
7. State left behind by a crash can be cleared with `tools/cleanup-runtime-state.ps1`
   (`-Apply` deletes, `-StopOrphans` also stops overlay/helper processes with no live owner).

## Tests

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File plugins/usage-hub/tests/run-tests.ps1
```

The suite is hermetic: no network access, no real user data, temporary directories only. It covers
the rollout scanner, the extension parsers, the receiver's origin gates and body limits, credential
ordering, the CC Switch database path, adapter matching and the MCP end-to-end harness. Add a test
next to the module you touch and keep the run green; CI runs the same script on `windows-latest`.