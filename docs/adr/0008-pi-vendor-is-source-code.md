---
id: 0008
title: pi vendor 即项目源码，EvolveFlow 集成直接写在 pi 内部
status: accepted
date: 2026-06-21
deciders: [M-24rjgc]
supersedes: []
related: [0006, 0007]
---

# ADR-0008: pi vendor 即项目源码，EvolveFlow 集成直接写在 pi 内部

## 背景（Context）

ADR-0007 选用 pi（earendil-works/pi）作为 Agent runtime 底座。ADR-0006 F2 哲学定下"fork 一次、自己接管、不追上游"。

迁移过程中发生过两次方向性错误，本 ADR 是对最终路线的诚实记录与修正：

1. **第一次错误**：vendor 只取了 pi 的 `agent` + `ai` 两个底层包，然后在 runtime 侧**自己重写**了 harness-manager / session-store / event-mapper / system-prompt / native-tools / sidecar-pi-bridge 六个文件（约 1500 行）。这违背了"不重写"——本质是把 pi 当参考，自己另起一套。

2. **第二次错误**：误判 `AgentHarness`（L3）"事件转发坏了"，降级到 bare `Agent`（L2），然后因为 L2 没有持久化/工具/hook，又手写补齐这些。后续核查源码发现 **AgentHarness 从未坏**（`handleAgentEvent` agent-harness.ts:510-537 全 emit，`createStreamFn` :376 正确），真根因是工具名含点号被 DeepSeek OpenAI 端点拒绝（400）。

## 决策（Decision）

**pi vendor 进来就是 EvolveFlow 自己的代码，没有"上游"，没有"同步"。EvolveFlow 的 AI 定制直接写在 pi 包内部，不在 runtime 侧另起一套。**

具体路线：

1. **删除** runtime 侧所有手写 AI 层（harness-manager / session-store / event-mapper / system-prompt / native-tools / sidecar-pi-bridge）。

2. **在 pi 包内部**（`packages/evolveflow-vendor-pi-agent/src/harness/evolveflow/`）加集成层：
   - `create-evolveflow-harness.ts`：建 pi 原生 `AgentHarness` + `Session` + `JsonlSessionStorage`，经 `AgentHarnessOptions` 接缝注入 EvolveFlow 定制
   - `mode.ts`：4 mode 定义 + 权限判断
   - `tool-sanitizer.ts`：工具名 sanitize（DeepSeek OpenAI 端点约束）
   - `native-tools.ts`：read/glob 文件工具
   - `pdf-extract.ts`：PDF 文本抽取（pdfjs-dist）
   - `system-prompt.ts`：EvolveFlow persona + `<evolveflow_context>` 渲染
   - `index.ts`：导出

3. **用 pi 原生组件**：
   - `AgentHarness`（L3）作为 agent 核心，事件转发 + session 持久化都由 pi 内部处理
   - `Session` + `JsonlSessionStorage` 做会话持久化（pi 原生，非手写）
   - `NodeExecutionEnv` 做文件/shell 执行环境

4. **runtime 侧只剩极薄胶水**：`ai-pi-glue.ts`（~250 行）创建 EvolveFlowHarness + 转发 JSON-RPC notification + auto 确认 + 单次补全（给 Dream）。

5. **DeepSeek 适配**（经 pi 接缝注入，不改 pi 内部）：
   - 模型：`getModel('deepseek', 'deepseek-v4-pro')`（pi-ai 注册表真实 id）
   - 端点：DeepSeek 的 OpenAI 兼容端点（pi-ai 默认，非 Anthropic）
   - apiKey：经 `AgentHarnessOptions.getApiKeyAndHeaders` 注入
   - 工具名：`task.create` → `task__create`（sanitize），execute 闭包用原名

## 理由（Rationale）

- **F2 一致性**：pi 是源码不是依赖。在 pi 内部加集成 = 改自己的代码；runtime 侧重写 = 学习 pi 后另起一套，违背 F2。
- **单一真相源**：所有 AI 逻辑（权限、持久化、工具、prompt）都在 pi 包一个地方，不会出现 runtime 与 pi 两套逻辑漂移。
- **pi 原生组件够用**：`AgentHarnessOptions` 的接缝（env/session/tools/systemPrompt callback/getApiKeyAndHeaders/on hooks/subscribe）足够注入 EvolveFlow 全部定制，不需要改 pi 内部热路径。
- **持久化不手写**：pi 的 `Session` + `JsonlSessionStorage` 是成熟实现（含分支/压缩/工具配对保护 C8），手写是重复造轮子且容易出错。

## 后果（Consequences）

正面：

- AI 逻辑单一真相源（pi 包内）
- 会话持久化用 pi 原生（成熟、含 compaction）
- runtime 侧极薄，维护负担低
- pi 升级？——ADR-0006 已明确：**不追上游**，pi 是自己的代码。

负面：

- pi 包体积增大（加了 evolveflow/ 集成层 + pdfjs-dist 依赖）
- pi 包的测试包含 EvolveFlow 集成层测试（已加 14 个，全过）
- pi 自带的 10 个测试在 Windows 失败（symlink/exec 上游问题），非本 ADR 引入

## 与 ADR-0007 的关系（修正）

ADR-0007 选 pi 的理由之一是"会话持久化是一等公民"。本 ADR 确认：**确实用 pi 原生持久化**（之前误降级到 L2 后手写持久化，已纠正）。

ADR-0007 没有明说"集成代码放哪"，本 ADR 补充：**放 pi 包内部**。

## 验证

- pi 包集成层：14 单测全过
- runtime：73 单测全过（删了测旧手写层的 4 个测试文件）
- 全栈 build：1783 modules，0 error
- （待）真实 DeepSeek e2e：createEvolveFlowHarness + pi 原生持久化
