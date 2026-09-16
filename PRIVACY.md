# Privacy Policy

Effective date: 2026-09-17

Usage Hub runs locally on Windows and is designed to keep provider and Codex usage data on the
user's machine.

## Data the plugin accesses

- Provider balance responses and optional DeepSeek web-bill data.
- Token counts and thread identifiers from Codex rollout logs.
- Provider credentials from local configuration sources when needed to query the configured
  provider.
- A provider website login token from Edge or Chrome local storage, in memory only, when the
  optional browser bridge cannot provide a current bill.

Message content from Codex conversations is not parsed or stored. API keys, cookies and website
tokens are not written to disk by the plugin.

## Network access

The plugin contacts only the provider endpoints needed to retrieve balance or usage information and
the local loopback receiver at `127.0.0.1:32146`. It does not send telemetry, analytics or usage
data to the maintainer or to an unrelated third party.

Setting `webUsage` to `false` disables provider-website requests.

## Local storage

Runtime state, cache files and user settings are stored under
`%LOCALAPPDATA%\UsageHubPlugin`. Deleting that directory removes the plugin's local state.

## Contact

Privacy questions may be sent to
[1561713602@qq.com](mailto:1561713602@qq.com). Changes to this policy will be recorded in the
repository and in [CHANGELOG.md](CHANGELOG.md).
