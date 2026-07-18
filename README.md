# Vibe Halo

Vibe Halo 是一个面向 Windows 的轻量 Electron 应用。它为 19 种 AI 编程客户端提供按需出现的审批、交互提醒和完成通知，并始终在异常时交回客户端原生流程。

## 开发

```powershell
npm install
npm test
npm start
```

启动时会检测已安装或已有配置的客户端，并对每个配置做独立首次备份和增量安装。应用离线、审批超时、窗口关闭、响应非法或某项集成停用时均返回无决定，让客户端继续原生流程。

Codex 0.129.0 及之后版本会要求用户审核新安装或发生变化的 command Hook。安装/升级后，请在 Codex 输入 `/hooks`，找到用户级 `~/.codex/hooks.json`，并信任 Vibe Halo 的 `PermissionRequest`、`Stop` 和 `UserPromptSubmit` 条目。Vibe Halo 会在托盘和诊断中显示待审核状态，但不会绕过 Codex 的 Hook 信任机制。

## 工作方式

- Codex、ZCode、Qwen Code、Copilot CLI、Claude Code、CodeBuddy、Hermes 和 OpenCode 支持灵动岛审批。
- ZCode `AskUserQuestion`、Claude/CodeBuddy Elicitation 与 Hermes clarify 支持精确协议回答；Codex `request_user_input` 等无稳定回答协议的场景仍只提醒。
- Kimi Code、Qoder 和 QoderWork 只显示客户端原生审批提醒；Gemini、Antigravity、Cursor Agent、Kiro、CodeWhale、Pi、OpenClaw 和 Reasonix 提供完成/状态通知。
- 所有客户端的审批进入同一个带稳定 ID 的 FIFO；去重键包含客户端 ID，相同工具调用只显示一次并把结果返回所有等待连接。
- 只有当前 adapter 明确暴露的选项才会产生决定；关闭、断线、超时、非法选项和编码失败都返回无决定。
- `Stop` 显示 8 秒完成通知，点击后可查看最后回复；新提示或审批会清理/压制旧完成通知。
- `request_user_input` 保留 Codex 原生回答界面；Vibe Halo 只显示“等待你的选择”提醒，并在对应输出写入会话后自动关闭。
- 等待输入监控精确解析 `~/.codex/sessions/**/rollout-*.jsonl`，不向 Codex 写入内容，也不会代替用户回答。
- 审批展开态默认展示命令、补丁或查询等主要内容；完整结构化参数保留在收起的详情中，底部操作栏始终固定可见。
- 展开态顶部中央的箭头可将灵动岛收回紧凑状态，不会关闭通知，也不会对待处理请求作出决定；`Esc` 保留相同行为。
- 本地服务只监听 `127.0.0.1`，每次启动生成新令牌并写入 `~/.vibe-halo/runtime.json`。
- 托盘“客户端集成”菜单可逐项停用/启用、重新扫描、修复或卸载全部；用户停用项不会在下次启动自动重装。
- 经过 SignPath 签名的公开版本会从 GitHub Releases 后台检查并下载稳定更新；下载完成后必须由用户在托盘中明确选择“重启并更新”，不会在普通退出时自动安装。
- 更新重启前会先把所有待处理审批和交互安全交回客户端原生流程。0.2.3 本身不含更新器，因此需要最后一次手动安装签名的 0.3.0 引导版。

## 项目结构

- `src/agent-registry.js`：19 个 adapter 的能力、归一化、选项和决策编码。
- `src/integration-manager.js`：检测、备份、增量安装、健康检查、修复和安全卸载。
- `hooks/vibe-halo-hook.js`：自包含的通用 command Hook。
- `hooks/integrations/`：OpenCode、Hermes、Pi 和 OpenClaw 托管插件资产。
- `src/approval-store.js`：审批队列、去重、超时和连接生命周期。
- `src/codex-input-monitor.js`：Codex 等待输入的只读 JSONL 增量监控。
- `src/input-request-store.js`：等待输入提醒的 FIFO、去重和生命周期。
- `src/server.js`：带令牌的 loopback HTTP 网关。
- `src/island-controller.js`：单一 Electron 灵动岛窗口和受限 IPC。
- `src/update-manager.js`：仅主进程可见的检查、下载和显式重启更新状态机。
- `src/shutdown-coordinator.js`：普通退出与更新共用的幂等安全关闭顺序。
- `src/hook-manager.js`：Hook 配置备份、迁移、修复与恢复。
- `docs/RELEASING.md`：SignPath、GitHub Actions 和签名发布流程。
- `test/`：协议、队列、服务器、Hook 和显示器回退测试。

## 许可证

本项目以 Vibe Halo 名义发布，派生自 Clawd on Desk，并以 AGPL-3.0-only 许可发布。参见 `LICENSE` 与 `NOTICE.md`。
