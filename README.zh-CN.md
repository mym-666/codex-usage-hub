# Codex Usage Hub

[![CI](https://github.com/mym-666/codex-usage-hub/actions/workflows/ci.yml/badge.svg)](https://github.com/mym-666/codex-usage-hub/actions/workflows/ci.yml)
[![License: GPL-3.0-only](https://img.shields.io/badge/license-GPL--3.0--only-blue.svg)](LICENSE)
![Platform: Windows](https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-0078D6)

一个 Windows 上的 Codex 桌面端插件：在 Codex 窗口旁常驻一个小悬浮窗，显示 Provider 余额、今日消费和当前会话的 Token 用量。Token 明细直接读 Codex 自己的记录，官网精确账单是可选的增强。

[English README](README.md)

![悬浮窗折叠态与展开态](plugins/usage-hub/assets/overlay.png)

## 显示什么

| 行 | 数据来源 |
| --- | --- |
| `provider · model` | `~/.codex/config.toml`，缺失时回落到 CC Switch |
| `余额` | 优先 Provider 余额接口，其次官网，标注 `（API）` / `（官网）` |
| `今日消费` | 优先官网精确账单，其次余额差值，最后 CC Switch 本地聚合 |
| `今日 Token：总 …` | 优先新鲜的官网账单 Token，否则用 Codex 会话日志（标注 `（Codex 统计）`） |
| `当前会话：Token …（输入 · 命中 · 未命中 · 输出）` | Codex 会话日志（`thread_token_usage`） |

模型单价来自插件自带的 Provider 适配器（`runtime/providers/*.json`）；适配器未声明的模型才回落到 CC Switch 的 `model_pricing` 价格表。

折叠时只显示一行：`余额 ¥12.34（API）· 今日 ¥3.21`。单击展开/收起，右键可立即刷新、跟随 Codex、调整字号、退出；托盘图标提供同样的菜单。

## 特性

- **零额外软件**：Token 用量与当前会话来自 Codex 自己的 rollout 日志，装完插件即可用。
- **余额尽量拿得到**：用这台机器上能找到的所有凭据依次探测 Provider 余额接口（插件配置 → Provider 配置 → CC Switch → Codex `auth.json`），失败时回落到浏览器桥接抓到的官网数值。
- **来源标注诚实**：每个数字都带来源，过期数据会被标注，而不是假装是最新的。
- **DeepSeek 官网账单桥接（可选，Edge）**：抓取平台自己的用量响应，得到精确的当日消费与 Token 明细。
- **纯本地**：无遥测、无账号、无云端服务；网页账单接收器只监听回环地址 `127.0.0.1:32146`，插件只与你配置的 Provider 通信。
- **MCP 工具**：`usage_snapshot`、`usage_runtime_status`、`usage_overlay_control`，让 Codex 自己读取和控制悬浮窗。
## 前置条件

| 条件 | 说明 |
| --- | --- |
| Windows 10/11 | 悬浮窗基于 WinForms；不支持 macOS / Linux |
| 支持插件与 MCP 的 Codex 桌面端 | `codex plugin --help` 能正常执行 |
| Node.js 22 或更高 | 通常 Codex 已自带。启动器只执行白名单目录里的 `node.exe`：`CODEX_MCP_NODE_PATH`、`%ProgramFiles%\nodejs`、`%LOCALAPPDATA%\OpenAI\Codex\runtimes`、`%USERPROFILE%\.cache\codex-runtimes`；`PATH` 上其它位置的 `node.exe` 会被跳过且不会被执行 |
| 已配置的 Provider | `%USERPROFILE%\.codex\config.toml` |
| 已登录 `platform.deepseek.com` 的 Edge | 可选，仅精确官网账单需要 |
| CC Switch | 可选，存在时补充 Provider 行与本地聚合；模型单价已内置在插件适配器里，只有适配器未声明的模型才回落到它的价格表 |

## 安装

1. 下载或克隆本仓库到任意目录。
2. 双击 `install.cmd`，或在该目录执行等价命令：

   ```powershell
   codex plugin marketplace add .
   codex plugin add usage-hub@usage-hub-local
   ```

   安装脚本会自行推导路径、校验 marketplace / 插件 / 扩展文件、查找 `codex.exe`，并把当前目录注册为 `usage-hub-local` marketplace。重复执行是安全的，已安装时会跳过。
3. **新建一个 Codex 线程**。插件 MCP 服务加载后会自动启动悬浮窗；它会跟随 Codex 窗口、在 Codex 最小化时隐藏、在 Codex 关闭后退出。

## 可选：安装 Edge 扩展（精确官网账单）

扩展不会被脚本自动安装，需要手动加载：

1. 让插件调用 `usage_runtime_status`，取返回的 `extensionPath`（指向已安装插件缓存里的 `plugins/usage-hub/edge-extension`）。
2. 打开 `edge://extensions`，开启开发人员模式。
3. 如果已装旧版 `Usage Hub Web Bill Bridge`，先移除旧扩展，或用“重新加载”选择新目录。
4. 点击“加载解压缩的扩展”，选择 `extensionPath` 目录。
5. 保持 Edge 登录 `platform.deepseek.com`。

扩展版本必须是 **1.7.1**：1.6.0 会静默丢弃抓到的账单，1.7.0 缺少账户余额接口的路径常量（余额永远抓不到）。由于插件缓存目录带版本后缀，**每次插件更新后都要重新加载扩展**。

不装扩展也能用：今日消费回落到余额差值估算，Token 明细回落到 Codex 会话日志，并各自标注来源。
## MCP 工具

| 工具 | 用途 |
| --- | --- |
| `usage_snapshot` | 余额、今日用量、当前会话、Token 明细、模型单价、来源与警告 |
| `usage_runtime_status` | 悬浮窗 / helper / 网页账单服务状态、扩展路径、运行配置、`receiverError`、`webBillServer.foreign` |
| `usage_overlay_control` | `show` / `hide` / `restart` 悬浮窗 |

`usage_snapshot` 里值得注意的字段：

- `today.tokenSource`：`api`（接口返回）、`estimate`（单请求估算）、`dom-scrape`（页面文字刮取，仅供参考）、`cc-switch`（本地统计）。
- `today.tokenScope`：`web`（官网精确口径）或 `codex`（Codex 日志口径）。
- `balance.source`：`provider-api` 或 `web-extension`。
- `session.source`：恒为 `codex-log`，描述最近写入的 Codex 线程。
- `source.providerIdentity`：`codex-config` 或 `cc-switch`。
- `source.databaseMode`：`direct` 或 `copy-fallback`（后者表示 CC Switch 数据库无法就地只读打开，用了私有副本）。
- `webBillStatus`：恒带 `untrusted: true`，因为它来自浏览器页面。

完整数据流见 [docs/architecture.md](docs/architecture.md)。

## 配置

`%LOCALAPPDATA%\UsageHubPlugin\config.json` 是可选的，不配置也能正常工作：

| 键 | 默认值 | 作用 |
| --- | --- | --- |
| `refreshSeconds` | `60` | 快照刷新间隔 |
| `webUsage` | `true` | 设为 `false` 可完全关闭对 Provider 官网的请求 |
| `allowBalanceDelta` | `true` | 允许用余额下降量估算今日消费 |
| `browserOrder` | `["edge", "chrome"]` | 需要从浏览器存储读取登录 Token 时的顺序 |
| `apiKey` | `""` | 余额探测使用的 Provider Key |
| `providers.<id>.apiKey` | — | 按 Provider 覆盖 Key |
| `browserTokens.<webId>` | — | 直接指定官网 Token，不读浏览器存储 |
| `providersDirs` | `[]` | 额外适配器目录（见 [docs/architecture.md](docs/architecture.md)） |
| `overlayAutoStart` | `true` | 设为 `false` 后悬浮窗不在启动时拉起，等调用 `usage_overlay_control` 再启动 |
| `overlayStartDelaySeconds` | `3` | 自动启动悬浮窗前的延迟，避免和 Codex 自身启动叠加 |
| `overlayIdleExitSeconds` | `300` | Codex 关闭后隐藏的悬浮窗保持热启动的时长，重开 Codex 直接复用（设 `15` 恢复旧的立即退出） |

## 性能

插件运行在 Codex 进程旁边，因此必须尽量不占用它的资源：

- 悬浮窗（PowerShell + WinForms）与 helper 守护进程由插件 MCP 服务拉起。自动启动会按 `overlayStartDelaySeconds`（默认 3 秒）错峰，避免和 Codex 自身启动过程同时抢资源。
- Codex 关闭后，隐藏的悬浮窗会按 `overlayIdleExitSeconds`（默认 300 秒）保持热启动，下一个 MCP 服务会复用它，所以在同一台 Codex 里切换线程不会重复付冷启动成本。注意：Codex 退出时会终止自己的进程树，整机重启通常仍会回收悬浮窗——需要跨 Codex 存活请用下面的独立模式。
- helper 默认每 60 秒（`refreshSeconds`）轮询一次，并且只在内容真的变化时才重写 `snapshot.json`（仅 `updatedAt` 变新不算变化），所以没有新数据的那一拍既不会写盘也不会触发重绘；悬浮窗自身的定时器在卡片隐藏时也会跳过工作。
- `usage_overlay_control` 的 `show` / `restart` 不会等待错峰延迟。

### 按需 / 独立运行悬浮窗

在 `config.json` 里设置 `"overlayAutoStart": false` 后，悬浮窗、helper 与 web-bill 接收器完全不会随 Codex 启动（看门狗也不会把它们拉起来）。

按需模式下，第一次使用插件时悬浮窗也会自己出现：`@Usage Hub`、默认提示词 `Show my current Codex usage and balance.`，或任意一次 `usage_snapshot` 调用都会把它拉起来。下面的启动器针对的是另一种需求——希望悬浮窗跨 Codex 重启一直存活。

```powershell
# 可直接双击，也可在终端执行：
tools\start-usage-hub.cmd     # 独立悬浮窗：不是 Codex 的子进程，重开 Codex 也不会被杀掉
tools\stop-usage-hub.cmd      # 停止悬浮窗、helper 与 web-bill 接收器
tools\usage-hub-overlay.cmd status
```

独立模式与插件共用同一个数据目录，托盘菜单、字号设置、官网账单桥接都照常工作，`usage_runtime_status` 也会把它报告为当前悬浮窗。如果你更希望由 Codex 托管，改用 `usage_overlay_control` 的 `show` 即可。

清理崩溃或强制关机留下的残留状态：

```powershell
# 只报告，不修改
powershell -NoProfile -ExecutionPolicy Bypass -File tools/cleanup-runtime-state.ps1
# 清理失效的 owner/pid 文件，并停止成为孤儿的悬浮窗/helper 进程
powershell -NoProfile -ExecutionPolicy Bypass -File tools/cleanup-runtime-state.ps1 -Apply -StopOrphans
```

## 隐私

- 所有数据都留在本机：没有遥测，也不向任何第三方端点发送数据。
- 插件不会把 API Key、Cookie、平台 Token 写入磁盘。当浏览器桥接没有提供当日账单时，helper 会**在内存中**读取 Edge/Chrome `Local Storage` 里对应官网来源的登录 Token，并且只用于向同一个官网发起请求。把 `webUsage` 设为 `false` 可以完全关闭这条路径。
- 写入 `plugin.log` 或 `usage_snapshot` 之前，凭据形态的字符串会被脱敏。
- 读取 Codex 会话日志时只取 Token 数与线程 id，不解析、不保存对话内容。

完整隐私说明见 [PRIVACY.md](PRIVACY.md)；威胁模型与漏洞上报方式见 [SECURITY.md](SECURITY.md)。
## 常见问题

| 现象 | 排查 |
| --- | --- |
| 没有悬浮窗 | 新建一个 Codex 线程（悬浮窗由插件 MCP 服务创建），再调 `usage_runtime_status` 看 `overlay.running` 与 `ownerHeartbeatAt` |
| 悬浮窗刚出现就消失 | `ownerHeartbeatAt` 应在 60 秒内更新。在悬浮窗菜单点过“退出”会抑制自动重启，直到插件重新加载 |
| `receiverError` 非空 | 32146 端口被占用，或 helper 启动失败；请原样反馈其中的 `code` 与 `message` |
| 余额显示 `--` | 没有可用凭据探测到余额接口；可配置 `apiKey`，或安装 Edge 扩展走官网 |
| 今日消费像是估算值 | `today.source` 为 `balance_delta` 或 `cc-switch`，说明官网账单缺失或已过期 |
| 重开 Codex 后感觉卡顿 | 悬浮窗是独立的 PowerShell + WinForms 进程。可调大 `overlayStartDelaySeconds`、把 `overlayAutoStart` 设为 `false`，或用 `tools/cleanup-runtime-state.ps1 -Apply -StopOrphans` 清理残留 |
| Token 标注为页面刮取（`dom-scrape`） | 数据来自页面文字；打开一次 `platform.deepseek.com/usage` 让扩展抓到接口响应，或等它回落到 Codex 日志口径 |

## 开发

```powershell
# 跑完整测试（69 个用例，不联网、不需要真实用户数据）
powershell -NoProfile -ExecutionPolicy Bypass -File plugins/usage-hub/tests/run-tests.ps1

# 只跑部分用例
powershell -NoProfile -ExecutionPolicy Bypass -File plugins/usage-hub/tests/run-tests.ps1 -NamePattern balance

# 校验插件 / marketplace / MCP / 扩展清单
powershell -NoProfile -ExecutionPolicy Bypass -File tools/validate-manifests.ps1
```

- 架构与数据流：[docs/architecture.md](docs/architecture.md)
- 贡献指南与本地迭代流程：[CONTRIBUTING.md](CONTRIBUTING.md)
- 版本变更：[CHANGELOG.md](CHANGELOG.md)
- 社区行为准则：[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
- 支持与联系方式：[SUPPORT.md](SUPPORT.md)
- 安全政策：[SECURITY.md](SECURITY.md)
- 隐私说明：[PRIVACY.md](PRIVACY.md)
- 作者与版权：[AUTHORS.md](AUTHORS.md)、[COPYRIGHT](COPYRIGHT)

## 卸载

在 `edge://extensions` 移除扩展，然后：

```powershell
codex plugin remove usage-hub
codex plugin marketplace remove usage-hub-local
```

插件不会创建 Windows 登录启动项；之后可以直接删除数据目录 `%LOCALAPPDATA%\UsageHubPlugin`。

## 作者

Andy Miao（[@mym-666](https://github.com/mym-666)）· [1561713602@qq.com](mailto:1561713602@qq.com)

## 许可证

Copyright (C) 2026 Andy Miao.

Codex Usage Hub 是自由软件：你可以依据自由软件基金会发布的 GNU 通用公共许可证第 3 版
（仅第 3 版）重新发布和/或修改它。完整许可证文本见 [LICENSE](LICENSE)。