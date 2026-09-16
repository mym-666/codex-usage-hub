# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Public-repository files: `AUTHORS.md`, `COPYRIGHT`, `CODE_OF_CONDUCT.md`, `SUPPORT.md`,
  `PRIVACY.md`, `THIRD_PARTY_NOTICES.md`, a feature-request form, code owners and Dependabot
  configuration for GitHub Actions.
- Author and contact metadata for Andy Miao in the package and plugin manifests.

### Changed

- License changed from MIT to GPL-3.0-only before the public release.
- Repository, homepage, issue and security links now point at the public GitHub project.

### Fixed

- Tests: replaced `fs.cpSync` in the MCP smoke test with a small recursive copy helper.
  Node 22.23.x can crash natively on Windows when `cpSync` copies this plugin tree, which made
  the Node 22 CI job fail even though the plugin itself was healthy. The MCP child now also
  suppresses Node 22's known `node:sqlite` ExperimentalWarning so the protocol test checks
  protocol output instead of runtime warning noise.

## [2.4.1] - 2026-09-13

### Fixed

- Extension 1.7.1: `edge-extension/inject.js` called `isBalanceUrl()` against a `USER_SUMMARY_PATH`
  constant that was never defined, so the `ReferenceError` was swallowed by that function's own
  `catch` and every `/api/v0/users/get_user_summary` response was dropped. The website balance
  never reached `/web-balance`, which left the overlay showing `--` unless a provider API key
  answered. Adds the missing constant plus a regression test that runs the real page hook.

## [2.4.0] - 2026-09-13

### Added

- Providers: DeepSeek now ships its own price table in `runtime/providers/deepseek.json` (`pricing`),
  so a unit price no longer requires CC Switch. `pricing.source` reports `builtin`, or `cc-switch`
  for a model the adapter does not declare, or `unavailable` when neither has the model.
- Tests: `tests/pricing.test.mjs` freezes the lookup rules (exact id, id prefix, longest pattern
  wins) and the precedence (adapter -> CC Switch -> unavailable).

### Changed

- Balance: with `apiKey` set in `config.json`, the provider balance API is probed with that key
  first (`balance.credential: "config"`), so machines without CC Switch still get a live balance.
  Every other credential keeps its previous place in the order: per-provider config, CC Switch,
  Codex `auth.json`.
- Docs: README, architecture and the plugin skill now describe the built-in price table and which
  sources remain optional (CC Switch, Edge web-bill bridge).

## [2.3.3] - 2026-09-13

### Fixed

- Overlay: owner heartbeats are normalised to local time before the staleness check. Windows
  PowerShell 5.1 hands the ISO string through as a string (already correct), but PowerShell 7's
  `ConvertFrom-Json` returns a `[datetime]`, and re-parsing its `ToString()` form on a UTC+8
  machine made a fresh heartbeat look eight hours old - enough to prune a live owner and close the
  overlay. The runtime always launches Windows PowerShell, so this was latent, not active.
- Tools: `cleanup-runtime-state.ps1` uses the same normalisation, so a recently dead owner is
  treated as transient instead of being deleted immediately when the script runs under PowerShell 7.

## [2.3.2] - 2026-09-13

### Added

- MCP: `usage_snapshot` starts the managed overlay when none is running, so in on-demand mode
  (`overlayAutoStart: false`) using the plugin - "@Usage Hub" or the manifest default prompt
  `Show my current Codex usage and balance.` - brings the card up without clicking a launcher.
  The start runs in the background, so the snapshot answer is never delayed by a PowerShell start.
- Skill: documents the on-demand lifecycle and the standalone launcher, and points the agent at
  `usage_overlay_control { action: "show" }` instead of a Windows startup shortcut.

### Changed

- Tests: the MCP smoke test now also calls `usage_snapshot` while the overlay launcher is
  unavailable, freezing the rule that the data answer must still be produced.

## [2.3.1] - 2026-09-13

Follow-up after measuring the plugin on a busy desktop: the overlay is now a first-class on-demand
component instead of something only Codex can own.

### Added

- `scripts/overlay-standalone.ps1` with `tools/start-usage-hub.cmd`, `tools/stop-usage-hub.cmd` and
  `tools/usage-hub-overlay.cmd` (start/stop/status) for an overlay that is **not** a child of Codex.
  It keeps following the Codex window when one is visible and survives Codex restarts, so the
  PowerShell + WinForms start cost is paid once, when the user asks for it.
- Overlay: `-Standalone` switch, which drops the owner-heartbeat requirement so the process has no
  Codex lifetime dependency.

### Changed

- Overlay: `overlayAutoStart: false` now also disables the watchdog restart. "Keep the overlay out
  of Codex" really means it: nothing starts until a tool call or the standalone launcher asks for it.
- Docs: the warm-reuse note now states what actually happens - Codex terminates its process tree on
  exit, so warm reuse mainly covers thread churn, and standalone mode is the way to outlive Codex.

## [2.3.0] - 2026-09-13

Performance release: the plugin no longer competes with Codex for CPU, disk and memory around
start-up, and reopening Codex reuses a warm overlay instead of paying the PowerShell + WinForms
cold start again.

### Added

- `config.json` knobs for the managed overlay: `overlayAutoStart` (keep the overlay off until a
  tool calls for it), `overlayStartDelaySeconds` (default 3) and `overlayIdleExitSeconds`
  (default 300). `USAGE_HUB_OVERLAY_START_DELAY_MS` overrides the delay for one host.

### Changed

- Overlay: the automatic start is staggered by `overlayStartDelaySeconds`, so the PowerShell +
  WinForms cold start no longer lands on top of Codex's own start-up burst. `usage_overlay_control`
  still starts or restarts it immediately.
- Overlay: a hidden overlay stays warm for `overlayIdleExitSeconds` (default 300s) after Codex or
  the MCP server goes away, so reopening Codex reuses it. Set `15` to restore the old
  close-immediately behaviour.
- Overlay: owner heartbeats are cached for two seconds and stale owner records are swept once a
  minute instead of on every 1s follow tick; the DPI probe is throttled to once per 4s instead of
  creating a GDI `Graphics` object every second; the control channel polls every 1.5s instead of
  every 0.8s. This is the B13 follow-up from the security review - the polling cost itself is
  reduced, not just re-frequencied.
- Overlay: the card repaints only when `snapshot.json` really changed. A hidden or unchanged card
  costs nothing per tick.
- Helper: default `refreshSeconds` is 60 (was 20), and the daemon skips rewriting `snapshot.json`
  when nothing except `updatedAt` moved, so a tick with no new data writes nothing and repaints
  nothing. (A stale-data warning that counts minutes is a real content change and still writes at
  most once per interval.)
- MCP server: the overlay watchdog moved from 5s to 15s and caches the running PID, so an idle
  thread stops re-reading `overlay.pid` every five seconds.

### Fixed

- Overlay: it used to close itself five seconds after the MCP server vanished, which made every
  Codex restart pay a full cold start. The "no owner" and "no Codex window" paths now honour
  `overlayIdleExitSeconds`.

## [2.2.1] - 2026-09-13

### Removed

- Overlay: dropped the standalone `缓存命中` / `未命中缓存` / `输出` rows from the expanded view and
  deleted the now-unused formatting code. The `今日 Token` total and the current-session
  breakdown (`输入 · 命中 · 未命中 · 输出`) are unchanged.
- Overlay: the expanded body no longer repeats the provider/model line that the window title
  already shows.
- Overlay: reduced the expanded window height (340 -> 230 at 100% scale) so the card keeps room
  for a wrapped warning without three rows of empty space.

### Changed

- Plugin manifest: added license, repository, homepage, logo, composer icon and screenshot metadata;
  version moved from the local cachebuster suffix to `2.2.1`.
- Repo tooling: `tools/validate-manifests.ps1` checks the plugin, marketplace, MCP and extension
  manifests locally and in CI.
- Docs: consolidated the Chinese install guide into `README.zh-CN.md` and rewrote `README.md` for a
  public audience; added `docs/architecture.md`, `SECURITY.md` and `CONTRIBUTING.md`.
- Repo: added `LICENSE` (MIT), `.gitattributes`, `.editorconfig`, CI workflow, issue/PR templates and
  `tools/bump-cachebuster.ps1` for the local plugin iteration loop.
- `install.cmd`: corrected the stale "extension must read 1.6.0" notice to 1.7.0 and restored CRLF line endings.

### Fixed

- Website tokens scraped from page text no longer replace Codex's own daily total. The DeepSeek usage
  page also renders an account-wide figure, and a text scrape cannot tell it apart from today, so
  `today.tokenScope` only prefers `web` when the website value came from an API field. Reported after
  the overlay showed 723.44M as "today" while Codex's own logs said 219.77M.
- A stale website balance (browser closed for more than 15 minutes) is now still reported, marked
  `（官网，已过期）`, instead of collapsing to `--` with a `未探测到余额接口` warning.
- The Edge page-text fallback no longer accepts a bare `总 Tokens` line as today's usage.
- The overlay no longer appends a source suffix to a balance it does not have (`--（API）`), and the
  page-scrape marker moved from the cost row to the token row it actually describes.

## [2.2.0] - 2026-09-13

### Added

- `runtime/codex-usage.mjs`: incremental scanner for Codex rollout logs
  (`~/.codex/sessions/**/rollout-*.jsonl`). It reads `token_usage_record` entries, deduplicates by
  `response_id`, filters by local midnight and caches byte offsets in `codex-usage-cache.json`.
- Provider identity from `~/.codex/config.toml` (`readCodexProvider`) and model display names from
  Codex's own model catalog, so the plugin works without CC Switch.
- Balance capture from the provider website: the Edge extension posts `get_user_summary` results to
  `POST /web-balance`, and the helper prefers an API answer over a fresh website value.
- Overlay: current-session line with the token breakdown, balance source suffix `（API）` / `（官网）`
  and a `（Codex 统计）` marker when today's tokens come from Codex logs.
- Website usages are labelled with `tokenSource` (`api` > `estimate` > `dom-scrape`) end to end.

### Changed

- Balance probes now try every available credential in order (plugin config, provider config,
  CC Switch, Codex `auth.json`) and continue after 401/403 instead of giving up on the first one.
- Helper refresh interval default changed from 60 s to 20 s.
- Extension 1.7.0 captures the account balance in addition to the daily bill; 1.6.x silently
  dropped captured bills.

### Removed

- Overlay: model pricing row (the `pricing` field is still available through `usage_snapshot`).

## [2.1.0] - 2026-09-13

### Added

- Codex plugin packaging: repo-local marketplace, MCP server, managed overlay lifecycle, tray icon.
- Loopback web-bill receiver on `127.0.0.1:32146` with host/origin/`Sec-Fetch-Site` validation and a
  token-protected shutdown and refresh endpoints.
- Hermetic test suite (`node:test`) covering the receiver, adapters, credential order, database
  access and an MCP end-to-end harness.

### Fixed

- Security review findings V1-V10 and B1-B14, including adapter matching (a category-only match can
  no longer inherit another provider's endpoints), URL allow-listing for credentialed requests,
  secret redaction in logs and snapshot fields, and read-only CC Switch database access with a
  copy fallback.