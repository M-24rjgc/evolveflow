# PRD: 替换 AI Runtime 底座为 pi

> Feature slug: `agent-framework-replacement`
> 状态：ready-for-agent
> 决策依据：ADR-0006（F2 fork）、ADR-0007（选 pi）、decision-map #1-#5

## Problem（要解决什么）

EvolveFlow 自研 AI runtime（packages/evolveflow-runtime）已暴露根本性问题：

- 会话不持久化（ai_sessions 表建了从不写入，重启全丢）
- sidecar.ts 1700 行上帝进程，难维护难测试
- 手写的 loop/client 压缩/重试频出 bug（已修 10 个，但根源是自研复杂度）
- 无法支撑愿景里的"插件=能力包"扩展机制

## Solution（怎么解决）

用 `earendil-works/pi`（MIT, TS/Node, harness）替换自研 runtime，以 SDK 模式
嵌入现有 sidecar，通过桥接扩展把 CapabilityRegistry 暴露为 pi 工具。
详见 decision-map #3（共存方案）、#4（落地策略）。

## User Stories

1. 作为用户，我在 AI 页聊天后重启应用，**能看到历史会话**（pi JSONL 持久化）
2. 作为用户，AI 调用 task.create 等能力时**行为与现在一致**（桥接扩展保证）
3. 作为开发者，我能**用 pi 扩展机制加新能力**（不再改 sidecar 巨石）
4. 作为开发者，runtime 代码**可测试**（pi 的 InMemorySessionRepo 支持无 IO 测试）

## Implementation Decisions（实现决策）

- 嵌入方式：**SDK 模式**（进程内 import，非 RPC，规避 framing 坑）
- pi 源码放置：**vendor 进 packages/**（非 submodule，符合 F2）
  - `packages/evolveflow-vendor-pi-agent` ← pi/packages/agent
  - `packages/evolveflow-vendor-pi-ai` ← pi/packages/ai
- 砍掉：pi 的 coding-agent/tui/docs/skills（编码向，不要）
- 保留不动：evolveflow-storage/domain/capabilities（护城河）
- 桥接：新建 `packages/evolveflow-pi-bridge`，遍历 registry.list() 注册为 pi tool
- 会话：pi 用自带 JSONL（与业务 SQLite 物理隔离，不碰 ai_sessions 空壳表）
- DeepSeek：用 pi-ai 的 provider 适配，替换自研 initAiEngine

## Implementation Steps（8 步，每步可验证）

### 步骤 0：拉取 pi 源码（⚠️ 需用户执行，AI 沙箱限制）

```bash
git clone --depth 1 https://github.com/earendil-works/pi.git /tmp/pi
cp -r /tmp/pi/packages/agent packages/evolveflow-vendor-pi-agent
cp -r /tmp/pi/packages/ai packages/evolveflow-vendor-pi-ai
rm -rf /tmp/pi
```

验证：`packages/evolveflow-vendor-pi-agent/package.json` 存在，name 为 @earendil-works/pi-agent-core

### 步骤 1：vendor 包接入 workspace

- 改名 vendor 包为 @evolveflow/vendor-pi-agent / @evolveflow/vendor-pi-ai
- 调整各自 package.json 的依赖（去掉 pi monorepo 内部引用，改成本地）
- 验证：`npm install && npm run build` 通过，两个包可被 import

### 步骤 2：桥接扩展骨架

- 新建 `packages/evolveflow-pi-bridge`
- 写桥接逻辑：遍历 registry.list()，每个 capability 用 pi.registerTool 注册
- schema 转换：EvolveFlow inputSchema → typebox（先用 Type.Unsafe 兜底）
- 验证：单元测试——bridge 初始化后，task.create 被注册为 pi tool，execute 调用 registry.invoke

### 步骤 3：sidecar 接入 pi SDK（最小对话）

### 步骤 3：sidecar 接入 pi SDK（最小对话）⚠️ 部分完成

- ✅ 新建 packages/evolveflow-runtime/src/pi-engine.ts：封装 runAgentLoop + 桥接 + DeepSeek
- ✅ pi-ai 能解析 DeepSeek 模型（deepseek-v4-pro，openai-completions api）
- ✅ build 通过、类型正确、API key 能传入
- ✅ 真实 DeepSeek API 调用通（smoke test 验证请求到达）
- ❌ **未完成**：runAgentLoop 返回的 assistant 内容为空——低层 loop 需要更多接线
  （streamFn 返回值消费、eventSink 聚合、工具执行闭环）。应改用 pi 的 AgentHarness
  高层封装，或正确接线 stream/event。
- 验证：build 通过 + smoke test 请求到达 DeepSeek（但响应内容未正确捕获）
- **下次 session 首要任务**：研究 agent-harness.ts，用高层封装重写 pi-engine.run()

### 步骤 4：删自研循环，迁移测试

- 删 loop.ts 的 runConversation/compactConversation/estimateTokens
- 删 client.ts 的自研 SSE/重试（pi-ai 接管）
- 保留 tools.ts 的 capabilityToToolName 映射（搬到 bridge）
- 重写 ai.test.ts（loop 测试删，bridge/context/tools 测试保留并适配）
- 验证：`npx vitest run` 全过

### 步骤 5：会话持久化 + 前端读历史

- pi 用默认 JsonlSessionRepo（落 ~/.pi 或 EvolveFlow app-data 目录）
- 前端 AIPage 改为读 pi 会话历史（替代 localStorage 兜底）
- 验证：重启应用后 AI 页显示历史会话

### 步骤 6：预装 pi-memctx

- 配置 settings.json packages 数组预装 pi-memctx
- 验证：对话中能看到记忆上下文注入

### 步骤 7：清理打包

- 删 pi 的 coding-agent/tui（已 vendor 但不用的部分）
- 清理 Tauri resources 打包配置
- 验证：`npm run build` 全栈通过，打包体积可控

## Testing Decisions

- 桥接扩展：单元测试（mock registry，验证 registerTool 调用 + execute 转发）
- pi SDK 集成：用 InMemorySessionRepo 做无 IO 集成测试
- 端到端：步骤 3 的手测作为集成验证点
- 回归：步骤 4 后确保 domain/storage/capabilities 测试不受影响（它们不依赖 runtime）

## Out of Scope（本 PRD 不做）

- Dream 改造成 pi 扩展（中期，单独排期，decision-map 步骤7）
- SqliteSessionStorage（按需，决策见 #3）
- 前端动态页面扩展机制（#6，fork 落地后）
- RPC 模式（选了 SDK，不需要）
- 追 pi 上游（F2 决定不追）

## Further Notes

- ADR-0007 记录了 pi 的已知短板及应对
- decision-map 有完整共存架构图和风险分级
- 每步必须过质量门槛：build + test + lint + typecheck
