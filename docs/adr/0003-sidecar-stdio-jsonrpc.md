# ADR-0003：AI 运行时作为 sidecar 进程，用 STDIO JSON-RPC 通信

- **状态**：已接受
- **日期**：2026-06-19（追溯记录）
- **相关代码**：`packages/evolveflow-runtime/src/sidecar.ts`、`apps/desktop-tauri/src-tauri/src/sidecar.rs`

## 背景

桌面应用（Tauri/React）需要调用 AI 能力（发请求、流式、工具调用、写数据库）。
这些逻辑是 Node.js 生态（better-sqlite3、fetch 流式解析），
而 Tauri 主进程是 Rust。需要决定 Node 逻辑以什么形态运行、怎么和前端通信。

## 决策

**AI 运行时作为独立 Node.js sidecar 进程，由 Tauri（Rust 侧）spawn，
通过 stdin/stdout 的行分隔 JSON-RPC（变体）通信。**

落地方式：

- Tauri 的 `SidecarManager`（Rust）spawn `node packages/evolveflow-runtime/dist/sidecar.js`。
- sidecar 用 readline 读 stdin、每行一条 JSON 消息，响应/通知写到 stdout。
- 前端不直接 spawn，而是通过 Tauri command → Rust → stdin 转发。
- Rust 侧有心跳监控 + 2 秒间隔的 supervisor，进程挂了自动重启。
- sidecar 主动推送的事件（reminder.due、ai.stream_chunk、heartbeat）作为 Tauri event 转发给前端。

## 后果

- **好处**：
  - 进程隔离：AI/Node 逻辑崩溃不拖垮 Tauri 主进程；supervisor 自动拉起。
  - 语言生态对齐：Node 生态的 AI/DB 库直接可用，不必移植到 Rust。
  - 清晰边界：前端 ↔ Tauri ↔ sidecar 三层职责明确。
- **代价 / 风险**：
  - 多一层进程通信，调试链路变长（前端 → Rust → sidecar → DeepSeek）。
  - 需要随安装包分发 Node 运行时（`prepare-tauri-resources.mjs` 把 node 二进制打进 resources）。
  - sidecar 找不到脚本的路径问题最易翻车（见 `sidecar.rs` 的 9 个候选路径）。
- **已采纳的规避**：sidecar 资源目录保持 `runtime/dist` 命名（即使源码已迁到 `packages/evolveflow-runtime/`），
  避免 9 个候选路径失配。见 ADR-0004 时期的重构说明。

## 备选方案

- **把 Node 逻辑嵌入 Tauri（用 tauri 的 node sidecar 一体化）**：耦合更高，放弃。
- **前端直接 fetch DeepSeek**：API Key 暴露到前端，且无法直接访问本地 SQLite，放弃。
- **本地 HTTP server 替代 STDIO**：多开端口、防火墙/端口冲突问题，放弃。
