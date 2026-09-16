# Security Policy

Usage Hub runs on a machine that holds provider API keys, browser profiles and Codex logs, so
security issues are treated seriously.

## Reporting a vulnerability

Please report privately - do not open a public issue:

1. Open the repository's **Security** tab and choose **Report a vulnerability**
   (GitHub Security Advisories), or
2. If advisories are unavailable, email
   [1561713602@qq.com](mailto:1561713602@qq.com) with `[Usage Hub security]` in the subject.
   Do not put exploit details in a public issue.

Include: affected version, Windows version, steps to reproduce, and the impact you observed. A
first response is usually possible within a few days; this is a volunteer project, so please be
patient. Please give us a chance to ship a fix before public disclosure.

## Supported versions

The latest published version receives fixes. Older plugin versions are not maintained - the plugin
and the Edge extension must be updated together, because the extension contract changes between
releases.

## Threat model

The plugin assumes that the local machine is trusted but that web pages are not.

**Assets**

- The provider API key from `config.json`, CC Switch, or Codex `auth.json`
- The provider website login token in Edge/Chrome `Local Storage`
- The Codex rollout logs under `%USERPROFILE%\.codex\sessions`
- The local receiver on `127.0.0.1:32146`

**Guarantees**

- Keys and tokens are never written to disk by the plugin and never sent to a third party. Any URL
  that would carry an `Authorization` header must resolve to the provider's own host, its website
  host, a subdomain of either, the same registrable domain, or loopback for a local proxy.
- The receiver binds loopback only and rejects requests whose `Host`, `Origin` or
  `Sec-Fetch-Site` headers do not match its expectations. Responses are unreadable from a web page.
- `/shutdown` and `/request-refresh` require a random token stored in the data directory that only
  the overlay reads.
- The MCP launcher executes `node.exe` only from an allowlist of installation roots.
- Text captured from a web page is sanitised, truncated and marked `untrusted: true`, so the agent
  quotes it rather than acting on it.
**Known limitations**

- `/web-bill`, `/web-balance`, `/web-bill-status` and `/health` cannot be token-protected, because
  an extension cannot read the plugin data directory. Any local process (and, in principle, a
  script running in an allowed origin) can blind-write to them. Writes are constrained: provider
  keys must match `[A-Za-z0-9._-]{1,64}` (prototype-polluting names rejected), `date` must be
  `YYYY-MM-DD`, `cost` must be a non-negative number, bodies are capped at 256 KB and the status
  text is sanitised and truncated before it reaches `usage_snapshot`.
- The helper may read a provider login token from Edge/Chrome `Local Storage` in memory when the
  extension is absent. The lookup targets the exact LevelDB key for that provider origin, so a
  token for another site is not picked up. Set `webUsage: false` in
  `%LOCALAPPDATA%\UsageHubPlugin\config.json` to disable all website requests.
- The plugin is Windows-only and relies on Windows PowerShell 5.1 for the overlay. It does not
  sandbox the provider adapter files that `providersDirs` points at; only add directories you trust.
- Numbers can be wrong without being malicious: a stale web bill, a `dom-scrape` token source or a
  balance-delta estimate is labelled but still approximate. Check the source labels before acting on
  a figure.

## Hardening checklist for users

- Keep the plugin and the Edge extension on the same version (`usage_runtime_status` reports both
  the expected extension path and the versions).
- Do not add adapter directories you do not trust.
- Delete `%LOCALAPPDATA%\UsageHubPlugin` if you suspect tampering; it only holds caches and settings.