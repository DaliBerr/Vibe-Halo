# Vibe Halo

Vibe Halo 是一个面向 Windows 的轻量 Electron 应用。它通过 Codex 官方 Hook 接收审批与任务完成事件，并只读监控 Codex 会话记录中的等待输入状态，在当前工作屏幕顶部显示按需出现的“灵动岛”。

## 开发

```powershell
npm install
npm test
npm start
```

第一次启动会备份并接管 `~/.codex/hooks.json` 中原 Clawd 的 Codex Hook。应用离线、审批超时或窗口关闭时，Hook 返回无决策，让 Codex 使用原生审批界面。

Codex 0.129.0 及之后版本会要求用户审核新安装或发生变化的 command Hook。安装/升级后，请在 Codex 输入 `/hooks`，找到用户级 `~/.codex/hooks.json`，并信任 Vibe Halo 的 `PermissionRequest`、`Stop` 和 `UserPromptSubmit` 条目。Vibe Halo 会在托盘和诊断中显示待审核状态，但不会绕过 Codex 的 Hook 信任机制。

## 工作方式

- `PermissionRequest` 进入带稳定 ID 的 FIFO 队列；相同工具调用只显示一次，并把结果返回给所有等待连接。
- “允许”和“拒绝”是唯一会代表用户作出决定的动作；关闭窗口、断线和 120 秒超时都返回无决策。
- `Stop` 显示 8 秒完成通知，点击后可查看最后回复；新提示或审批会清理/压制旧完成通知。
- `request_user_input` 保留 Codex 原生回答界面；Vibe Halo 只显示“等待你的选择”提醒，并在对应输出写入会话后自动关闭。
- 等待输入监控精确解析 `~/.codex/sessions/**/rollout-*.jsonl`，不向 Codex 写入内容，也不会代替用户回答。
- 审批展开态默认展示命令、补丁或查询等主要内容；完整结构化参数保留在收起的详情中，底部操作栏始终固定可见。
- 本地服务只监听 `127.0.0.1`，每次启动生成新令牌并写入 `~/.vibe-halo/runtime.json`。
- 托盘菜单可停用审批、修复或卸载 Codex 集成、查看诊断以及切换开机启动。

## 项目结构

- `hooks/`：自包含的 Codex 官方 Hook。
- `src/approval-store.js`：审批队列、去重、超时和连接生命周期。
- `src/codex-input-monitor.js`：Codex 等待输入的只读 JSONL 增量监控。
- `src/input-request-store.js`：等待输入提醒的 FIFO、去重和生命周期。
- `src/server.js`：带令牌的 loopback HTTP 网关。
- `src/island-controller.js`：单一 Electron 灵动岛窗口和受限 IPC。
- `src/hook-manager.js`：Hook 配置备份、迁移、修复与恢复。
- `test/`：协议、队列、服务器、Hook 和显示器回退测试。

## 许可证

本项目以 Vibe Halo 名义发布，派生自 Clawd on Desk，并以 AGPL-3.0-only 许可发布。参见 `LICENSE` 与 `NOTICE.md`。
