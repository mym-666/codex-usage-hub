# Contributing

Thanks for helping. Usage Hub is a Windows-only Codex plugin; the overlay is Windows PowerShell and
the runtime is Node.js 22+.

## Development setup

1. Windows 10/11 with the Codex desktop app installed (`codex plugin --help` must work).
2. Node.js 22 or newer, either from `%ProgramFiles%\nodejs` or from a Codex-managed runtime.
3. Clone the repository, then install the plugin from your checkout:

   ```powershell
   codex plugin marketplace add .
   codex plugin add usage-hub@usage-hub-local
   ```

4. Start a new Codex thread to load the MCP server and the overlay.

## Local iteration loop

Codex caches an installed plugin under a version-suffixed directory
(`%USERPROFILE%\.codex\plugins\cache\usage-hub-local\usage-hub\<version>`), so editing your checkout
does not change the running plugin. To pick up edits:

```powershell
# 1. bump the cachebuster suffix so Codex sees a new version
powershell -NoProfile -ExecutionPolicy Bypass -File tools\bump-cachebuster.ps1

# 2. reinstall from the local marketplace
codex plugin add usage-hub@usage-hub-local
```

The cache directory changes when the version changes, so reload the Edge extension from the new
`extensionPath` after an update. For quick UI checks you can also restart the overlay through the MCP
tool `usage_overlay_control` with `action: "restart"`.

The `+codex.<timestamp>` suffix is **local build metadata**: revert it before committing so the
repository keeps a clean semantic version (`2.4.0`, not `2.4.0+codex.20260913123456`).

**Installing a new version empties the previous version's cache directory.** A Codex thread that is
still running the old copy keeps working from memory, but every file it reads lazily afterwards
(provider adapters, launchers, skills) is gone, which shows up as confusing symptoms - for example
balance probes silently falling back to "未探测到余额接口". Reinstall only when you can start a new
thread immediately, or restore the old directory before continuing to work in the running one.

## Tests

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File plugins/usage-hub/tests/run-tests.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File plugins/usage-hub/tests/run-tests.ps1 -NamePattern adapter

# manifest checks (plugin, marketplace, MCP, extension)
powershell -NoProfile -ExecutionPolicy Bypass -File tools/validate-manifests.ps1
```

- Every test must be hermetic: no network access, no dependency on the developer's real data
  directory, no assumptions about the user's provider.
- Add a test next to the module you touch. A bug fix without a regression test is usually not
  merged.
- CI runs the same script on `windows-latest` with Node 22 and also parses every PowerShell file and
  JSON manifest.

## Code style

- JavaScript: ES modules, two-space indent, double quotes, `const` by default. No dependencies -
  the runtime deliberately has none.
- PowerShell: two-space indent. The overlay script stays Windows PowerShell 5.1 compatible (no
  `??`, no ternary operator).
- Keep comments that explain *why* a decision exists; delete comments that restate the code.
- Do not add a dependency to the runtime without discussing it first - the plugin must run inside
  Codex's plugin cache with nothing but Node.

## Commits and pull requests

- Conventional-ish messages (`fix:`, `feat:`, `docs:`, `test:`), imperative mood, one logical
  change per commit.
- Update `CHANGELOG.md` for anything a user can notice.
- Update the READMEs when behaviour, requirements or configuration keys change.
- Run the full test suite before opening a pull request and paste the result in the description.
- Keep diffs focused; unrelated formatting churn makes review harder.

## Never commit

- API keys, website tokens, cookies, `auth.json` contents or `plugin.log` excerpts
- Real balances, real token counts or screenshots of your personal data directory
- Local machine paths that identify you beyond the generic `%USERPROFILE%` form

If you accidentally commit a secret, rotate it first, then rewrite the history - deleting the file
in a later commit is not enough.

## UI changes

`runtime/usage-overlay.ps1` keeps a UTF-8 BOM on purpose: Windows PowerShell 5.1 would otherwise
mis-read the Chinese strings. Keep the file encoded as UTF-8 with BOM and LF line endings.

## Community and support

Participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Report conduct issues to
[1561713602@qq.com](mailto:1561713602@qq.com). For bugs and feature requests, use GitHub Issues
and follow [SUPPORT.md](SUPPORT.md). Do not report security vulnerabilities in a public issue;
follow [SECURITY.md](SECURITY.md).

## License of contributions

Usage Hub is licensed under GPL-3.0-only. By submitting a contribution, you agree that it may be
distributed under the same license. Sign off every commit with `git commit -s` to certify the
[Developer Certificate of Origin](https://developercertificate.org/).
