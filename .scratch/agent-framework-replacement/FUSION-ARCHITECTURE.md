# EvolveFlow × pi 融合架构规划

> 状态：**深度研究 + 源码逐行验证完成**（2026-06-20），等用户审阅。
> 前置：ADR-0006（F2 fork 哲学）、ADR-0007（选 pi）、decision-map（完整调研）、PRD（8 步迁移）。
> 方法：每个结论都附 `file:line` 证据，亲自读真实源码（pi vendor 包 + EvolveFlow runtime + pi-ai），不臆想。
> 本文件是这个决策点的最终架构产物。**它不是"pi 怎么接"，是"融合后的 EvolveFlow 长什么样"。**

---

## 0. 阅读指南 / 怎么用这份文档

1. 先读 §1（宏观架构）——回答"融合后是什么"。
2. 再读 §2（端到端数据流）——把抽象架构落到一次真实交互。
3. §3–§6 是接缝细节（留/砍、工具适配、内部改动、sidecar 对接）。
4. §7 是诚实的风险和未解决问题——**特别看 §7.1，里面有四个前 AI 没想透的真问题。**
5. §8 是对 PRD 8 步的修订。
6. 开头的 **§0.1"对初步草稿的修正"** 记录了我推翻前一版的几个判断——因为前一版也是我写的，我必须诚实标注哪里错了。

### 0.1 对初步草稿（本文件前一版）的修正

前一版草稿整体方向对（用 AgentHarness 不重拼 loop、工具一个不砍），但有几处**判断不准或与源码冲突**，本次已纠正：

| #      | 前一版说的                                                                 | 实际读源码后发现                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 证据                                                                                                   |
| ------ | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| C1     | pi-engine.ts 失败原因是"低层 loop 需要更多接线"                            | **真正的 bug 是 `streamFn` 参数顺序错了**。agent-loop 调 `streamFn(model, context, options)`（agent-loop.ts:304），但 pi-engine.ts:127 写成 `streamFn = (ctx, cfg) => streamSimple(model, ctx, cfg as never)`——把 `AgentLoopConfig` 当 options 传，签名不匹配，流式事件根本没消费对。                                                                                                                                                                                                                                                        | `agent-loop.ts:304` vs `pi-engine.ts:127-134`                                                          |
| C2     | R3：convertToLlm 的 default 分支会"静默丢弃自定义角色"导致响应空           | **不成立**。标准 `convertToLlm`（messages.ts:120-164）对 user/assistant/toolResult 直接 pass-through；问题角色只有自定义（custom/branchSummary 等）。而 pi-bridge 返回的是标准 `AgentToolResult`，会正常转成 `ToolResultMessage`。所以 R3 不是失败原因——C1 才是。                                                                                                                                                                                                                                                                            | `messages.ts:120-164`                                                                                  |
| C3     | R6：pi-ai 的 DeepSeek provider "需确认用哪个端点"                          | **已确认**。pi-ai 用 **OpenAI 兼容端点**（`https://api.deepseek.com` + `/chat/completions`，`api: "openai-completions"`），**不是** EvolveFlow 现在用的 Anthropic 兼容端点（`DEEPSEEK_ANTHROPIC_BASE_URL`）。这是真实的迁移考量，不是开放问题。`deepseek-v4-pro` 是真实 id。                                                                                                                                                                                                                                                                 | `models.generated.ts:3835-3874`、`openai-completions.ts:1187-1204`                                     |
| C4     | 工具实现"可直接从 pi 仓库复制"（R1 缓解方案）                              | **本地缓存里 coding-agent 源码是空的**（只有目录骨架 + 几个无关 .c 文件，0 个 .ts）。想拿 pi 的现成工具实现，必须重新完整 clone，或自己写轻量工具（pi 工具就是 `AgentTool` 定义 + 调 `ExecutionEnv`，不复杂）。                                                                                                                                                                                                                                                                                                                              | `Temp/pi/packages/coding-agent/src/**` 实际内容                                                        |
| C5     | Windows 兼容性"只需验证"                                                   | **低估了**。pi 的 `NodeExecutionEnv` Shell 在 Windows 上**硬找 bash**（`Git\bin\bash.exe` → PATH 上的 bash.exe → 失败），没有 bash 就直接 `shell_unavailable`。Tauri 桌面应用不能假设用户装了 Git Bash。这是必须正面处理的真问题。                                                                                                                                                                                                                                                                                                           | `nodejs.ts:158-195`、`162-184`                                                                         |
| C6     | R3 把 `getModel` 描述为"throws if unknown"（pi-engine.ts:81 注释也这么说） | **实际返回 `undefined`**，不抛错。后续 `.provider` 访问才抛 TypeError。代码能跑但语义 misleading。                                                                                                                                                                                                                                                                                                                                                                                                                                           | `models.ts:20-26`                                                                                      |
| **C7** | **§1.1 核心结论"用 AgentHarness(L3)"**                                     | **重大修正**。读完 pi 的 coding-agent 后发现:`AgentHarness` 在整个 pi 仓库**只有 1 处测试脚本**(`test/scratch/simple.ts:39`)用过,pi 自己的生产代码用的是 `Agent`(L2)+ 自研的 `AgentSession`(3148 行)。`agent-harness.md` 文档自陈 AgentHarness 是"current direction / migration target",带一串未完成 TODO(auto-compaction/retry/generic hooks)。**它是 pi 正在建、作者自己都还没切过去的半成品。** 经用户决策(见 §1.1 末尾),改走 `Agent + AgentSession` 成熟路线。本节及架构图、§4/§5/§6 中所有 "AgentHarness" 字样应理解为 "AgentSession"。 | `grep -rn "new AgentHarness"` 全仓仅 1 处;`agent-harness.md:244-410` 的 TODO 列表;用户 2026-06-20 决策 |
| **C8** | §7.2 R6 "JSONL 性能 + 可能丢工具配对"(隐含)                                | **核实后:工具配对风险不存在**。pi 的 `findValidCutPoints`(compaction.ts:267-305)**显式排除 toolResult 作为切点**(line 283-284),从设计上保证压缩永远不会切断 assistant 工具调用与其 toolResult。EvolveFlow 现在的 150 行 `adjustSplitForToolPairing`(loop.ts:774-927)是手写补救——pi 用"设计上就不切那里"规避了整个问题。                                                                                                                                                                                                                      | `compaction.ts:267-305` vs `loop.ts:774-927`                                                           |

---

## 目录

- **§0** 阅读指南（含 §0.1 对前版的 8 处修正 C1-C8）
- **§1** 融合后的宏观架构（含 §1.1 四层抽象/路线选择、§1.5 AgentSession 剥离计划）
- **§2** 一次典型交互的端到端数据流（含 §2.4 9 种流式事件映射表）
- **§3** pi 的哪些部分留、哪些砍
- **§4** pi 工具如何与 EvolveFlow 场景适配
- **§5** pi 内部哪些要改、怎么改（5 个接缝）
- **§6** sidecar 如何对接 pi
- **§7** 诚实的风险和未解决问题（含 §7.3 待用户决策的 4 个问题）
- **§8** 对 PRD 8 步的修订
- **附录 A** 源码阅读清单 · **附录 B** Explore agent 调研摘要 · **附录 C** AgentSession 剥离逐调用点

---

## 1. 融合后的宏观架构

### 1.1 核心发现：pi 有三层抽象 + 一个生产编排器，走成熟路线

读完真实源码（含这次重 clone 的 coding-agent），pi 的分层比初版文档判断的更丰富：

| 层                      | 入口文件                                                                           | 职责                                                                                                                                  | 成熟度                                                                                                        |
| ----------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **L1 · 纯 loop**        | `agent-loop.ts` 的 `runAgentLoop()` (agent-loop.ts:95-118)                         | 纯函数式 think→act→observe 循环，要调用者自备 context/config/emit/streamFn                                                            | ✅ 成熟，但太底层                                                                                             |
| **L2 · Agent**          | `agent.ts` 的 `Agent` class                                                        | loop 外包一层 transcript + 生命周期 + 队列                                                                                            | ✅ 成熟                                                                                                       |
| **L3 · AgentHarness**   | `harness/agent-harness.ts`                                                         | 面向嵌入者的精简 harness（session+compaction+hooks）                                                                                  | ⚠️ **半成品**：全仓仅测试用过，docs 自陈是 "current direction"，auto-compaction/retry/generic-hooks 都是 TODO |
| **★ L4 · AgentSession** | `coding-agent/src/core/agent-session.ts`（3148 行）+ `sdk.ts:createAgentSession()` | pi **自己天天在用**的生产编排层：工具注册表 + system prompt 重建 + **auto-compaction** + retry + 事件订阅 + session 持久化 + 扩展系统 | ✅✅ **生产成熟**                                                                                             |

**前 AI 写的 `pi-engine.ts` 用的是 L1 `runAgentLoop()`**，自己重拼 context/config/streamFn/noopSink，且 streamFn 参数顺序错（C1）导致响应空——这是错误的层级。

**两条候选路线的取舍**（已与用户确认，2026-06-20）：

| 维度            | AgentHarness（L3）              | **AgentSession（L4，已选）**                                             |
| --------------- | ------------------------------- | ------------------------------------------------------------------------ |
| pi 自己用过吗   | ❌ 仅测试脚本                   | ✅ coding-agent 全靠它                                                   |
| auto-compaction | ❌ TODO 未实现                  | ✅ `_checkCompaction` + `_runAutoCompaction`，agent-session.ts:1812/1904 |
| retry           | ❌ TODO 未实现                  | ✅ `auto_retry_*` 事件                                                   |
| 工具注册        | 要自己拼 `AgentTool[]`          | ✅ `createCodingTools(cwd)` / `customTools` 选项现成                     |
| system prompt   | `systemPrompt` callback（干净） | `ResourceLoader.getSystemPrompt()` 适配器（要写薄壳）                    |
| 接口面向谁      | 嵌入者（干净）                  | CLI（耦合 settings/extensions，要剥离）                                  |
| 工作量          | 接口干净但要陪 pi 建完半成品    | 剥 5 个协作对象的耦合，但热路径全保留                                    |

**决定：走 L4 `Agent + AgentSession`。** 理由：用 pi 每天在跑的成熟代码，不为半成品 API 陪绑。剥离工作虽非平凡但可控（详见 §1.5）。

**已核实的关键正确性保证**：AgentSession 的 auto-compaction 用的就是 `findValidCutPoints`（compaction.ts:267-305），**它从设计上不在 toolResult 处切**（:283-284 显式排除），所以压缩永远不会切断 assistant 工具调用与其 toolResult——EvolveFlow 现在 150 行手写的 `adjustSplitForToolPairing` 补救逻辑，pi 用设计规避了（C8）。这是迁移后长对话不会随机 400 崩溃的根本保证。

### 1.2 融合后整体架构图

```
┌──────────────────────────────────────────────────────────────────┐
│                     Desktop Shell (Tauri v2)                      │
│                                                                   │
│  React Frontend                                                   │
│  ├─ Chat UI（流式文本 + 工具执行通知）                              │
│  ├─ Task/Event/Schedule Views（读 capability 数据）                │
│  └─ Settings（API key、buddy level、agent mode）                  │
│                                                                   │
│  Rust Sidecar Manager（apps/desktop-tauri/...）                    │
│  ├─ spawn/kill Node sidecar 进程                                   │
│  └─ IPC bridge：Tauri invoke ↔ JSON-RPC stdin/stdout             │
└───────────────────────────┬──────────────────────────────────────┘
                            │ JSON-RPC over stdin/stdout
                            │
┌───────────────────────────▼──────────────────────────────────────┐
│              EvolveFlow Sidecar（瘦身至 ~600-700 行）              │
│                                                                   │
│  ┌─ JSON-RPC Router（保留）────────────────────────────────┐     │
│  │ • heartbeat / shutdown / rebuild_state                  │     │
│  │ • ai.stream → session.prompt() + 事件转 notification    │     │
│  │ • ai.cancel_stream → session.abort()                    │     │
│  │ • ai.get_context → buildConversationContext (保留)       │     │
│  │ • capability.* → registry.invoke()（直达，不走 agent）    │     │
│  │ • dream.* / buddy.* / summary.* （保留）                  │     │
│  │ • ai.get_sessions/delete_session/approve_tool           │     │
│  │   → 瘦成 pi session 生命周期适配器，或退役                 │     │
│  └──────────────────────────────────────────────────────────┘     │
│                                                                   │
│  ┌─ AgentSession Manager（新增 ~250 行）─────────────────┐     │
│  │ • Map<sessionId, AgentSession>                            │     │
│  │ • 创建：createAgentSession({                              │     │
│  │     cwd, model, customTools:[capability桥接+原生工具],    │     │
│  │     resourceLoader: EvolveFlowResourceLoader,  ← 注入点   │     │
│  │     settingsManager: EvolveFlowSettings (stub),           │     │
│  │     modelRegistry: EvolveFlowModels (stub),               │     │
│  │     sessionManager: SessionManager.create(cwd) })         │     │
│  │ • session.subscribe(event) → 映射 ai.stream_chunk         │     │
│  │ • beforeToolCall hook → mode 权限门 + 敏感路径拦截 +      │     │
│  │   auto 模式 await 用户确认（跨进程，带 120s 超时）         │     │
│  │ • afterToolCall hook → action_log 审计                    │     │
│  └──────────────────────────────────────────────────────────┘     │
│                                                                   │
│  ┌─ 剥离/适配层（新增 ~300 行，见 §1.5）──────────────────┐     │
│  │ • EvolveFlowResourceLoader → getSystemPrompt 返回        │     │
│  │   <evolveflow_context>（调 buildConversationContext）     │     │
│  │ • EvolveFlowSettings stub → 返回固化默认值                │     │
│  │   (compaction=on, thinking=medium, shell=auto)            │     │
│  │ • EvolveFlowModels stub → getApiKeyAndHeaders 返回 DeepSeek│     │
│  │ • ExtensionRunner：保留 pi 的、空载运行（hasHandlers=false）│     │
│  └──────────────────────────────────────────────────────────┘     │
│                                                                   │
│  ┌─ Orchestrators（保留，部分解耦）────────────────────────┐     │
│  │ • DreamOrchestrator（需把 ApiClient 换成 pi 模型调用）    │     │
│  │ • BuddyCore（零 AI 耦合，原样保留）                       │     │
│  │ • Reminder Poller（10s，纯业务，原样保留）                 │     │
│  │ • Daily Summary Scheduler（间接经 summary handler 调 AI） │     │
│  └──────────────────────────────────────────────────────────┘     │
└──────────────────────────────────────────────────────────────────┘
        │                    │                    │
        ▼                    ▼                    ▼
┌───────────────┐  ┌──────────────────┐  ┌──────────────────┐
│ Capability    │  │ pi AgentSession  │  │ Storage (SQLite) │
│ Registry      │  │ (L4 生产路线)     │  │                  │
│ (护城河，不动)│  │ ┌─ Agent ──────┐ │  │ • tasks          │
│ • task.*      │◄─┤ │ 转发事件      │ │  │ • events         │
│ • event.*     │  │ │ 管理队列      │ │  │ • schedule_blks  │
│ • schedule.*  │  │ └──────────────┘ │  │ • reminders      │
│ • reminder.*  │  │ ┌─ SessionMgr ─┐ │  │ • preferences    │
│ • undo.*      │  │ │ JSONL 树持久化│ │  │ • action_logs    │
│ • file.*      │  │ │ auto-compaction│ │  │ • dream_insights │
│ • (未来扩展)  │  │ │ (设计保护配对)│ │  │ • daily_summary  │
│               │  │ └──────────────┘ │  └──────────────────┘
│ 经 pi-bridge  │  │ ┌─ ToolReg ────┐ │
│ → AgentTool   │  │ │ createCoding │ │
│ (customTools) │  │ │  Tools(cwd)  │ │ ← pi 原生 read/bash/edit/write
│               │  │ │ + customTools│ │ ← + 能力工具 (pi-bridge)
│               │  │ └──────────────┘ │
│               │  │ ┌─ ExtensionRun│ │
│               │  │ │ 空载运行     │ │ ← 保留 pi 的、不装扩展
│               │  │ └──────────────┘ │
│               │  └──────────────────┘
└───────────────┘
```

### 1.3 各层职责：融合前 vs 融合后

| 层                | 融合前（当前）                                                                               | 融合后                                                                                              | 动作                                                                          |
| ----------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| **AI 大脑**       | 自研 `ai/loop.ts`（1110 行）+ 自研 `ai/client.ts`（504 行）DeepSeek SSE 客户端               | pi `AgentSession`（L4，3148 行生产代码）+ `Agent`（L2）+ pi-ai 的 `streamSimple`                    | **替换**：删 loop/client/deepseek/pi-engine，但保留 `ai/context.ts`（375 行） |
| **会话存储**      | 内存 `Map<sessionId, AiSessionState>`，进程死即丢；`ai_sessions`/`ai_messages` 空表从未写入  | pi `SessionManager` JSONL 树，支持分支/回退/压缩                                                    | **升级**：持久化（解 CONTEXT.md §198 的优先缺口）                             |
| **上下文压缩**    | 正则 + 字符串拼接 + 150 行手写 tool-use 配对补救（loop.ts:774-927）                          | pi AI 语义摘要，**设计层面保护工具配对**（C8）                                                      | **升级**：删掉手写补救，pi 设计上更稳                                         |
| **工具系统**      | 手写 `AnthropicTool` schema + 手写执行（ai/tools.ts:205 行）                                 | pi `createCodingTools(cwd)`（原生 read/bash/edit/write）+ pi-bridge 能力工具，经 `customTools` 注入 | **统一 + 扩展**：一个不砍，全留并新增                                         |
| **System Prompt** | 手写 4 模式（sidecar.ts:1425-1532），含 cache_control                                        | `EvolveFlowResourceLoader.getSystemPrompt()` 适配器返回 `<evolveflow_context>`                      | **迁移**：提取现有 prompt 到 ResourceLoader                                   |
| **流式协议**      | 单一 `ai.stream_chunk` notification，chunk.type 有 9 种                                      | pi `AgentEvent`（agent*start/message*_/tool*execution*_/...）                                       | **映射**：§2.4 给完整映射表（9 种 chunk 全保留）                              |
| **auto 模式确认** | 跨进程 promise：`pendingToolApprovals` Map + `waitForToolApproval`(120s) + `ai.approve_tool` | pi `beforeToolCall` hook 内 `await` 同一 promise（hook 是 sync-awaitable）                          | **保留语义，简化实现**：复用现有 Map/超时                                     |
| **业务核心**      | domain/storage/capabilities                                                                  | 不变                                                                                                | **不动**：护城河                                                              |
| **桌面外壳**      | Tauri + React                                                                                | 不变                                                                                                | **不动**                                                                      |

### 1.4 为什么这个架构是对的（对照愿景）

CONTEXT.md §26-53 的三层愿景——内置核心 / Agent 框架 / 插件系统——逐条对应：

- **内置核心**（日程/任务/提醒/排程）：domain/storage/capabilities 层完全不动，经 pi-bridge 暴露成 AgentTool。AI 调能力走的是和 UI 同一条 `registry.invoke()` 路径（pi-bridge/src/index.ts:104），所有变更照常记 action_log、可 undo。
- **Agent 框架**：就是 pi `AgentSession`。它的"最小核心 + 扩展即能力"（见 ADR-0007 §155-160）正是 EvolveFlow 想要的。mode/tool/skill/prompt 都是扩展点，auto-compaction/retry 已成熟。
- **插件系统**（未来）：pi 扩展系统能注册 mode/tool/skill/prompt（我们初期空载运行 ExtensionRunner，中期按需启用）；前端"新页面"是 EvolveFlow 自建（decision-map #6）。pi 已把后端那半铺好。

### 1.5 AgentSession 剥离计划（走 L4 路线的主要工作）

AgentSession 面向 CLI 设计，耦合 5 个 coding-agent 内部协作对象。Explore agent 逐个测绘了耦合点（file:line 见附录 C），剥离工作量分级：

| 协作对象            | AgentSession 调用次数   | 剥离策略                                                                                                                                                                             | 工作量                                           |
| ------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| **AuthStorage**     | **0 次**（不直接耦合）  | 无需处理                                                                                                                                                                             | 零                                               |
| **ResourceLoader**  | 8 次（6 个方法）        | 写薄适配器：`getSystemPrompt()` 返回 `<evolveflow_context>`，其余返回空                                                                                                              | **小**（~1 天）                                  |
| **ModelRegistry**   | 9 次（6 方法）          | 写 stub：`getApiKeyAndHeaders` 返回 DeepSeek key，`hasConfiguredAuth` 返回 true，其余（cycling/register）no-op                                                                       | **小**（~1 天）                                  |
| **SettingsManager** | 22 次（~15 方法）       | 写 stub：getters 返回固化默认值（compaction=on, thinking=medium, shell=auto）；setters 吞掉（sidecar 不持久化用户偏好变更）                                                          | **中**（~1-2 天）                                |
| **ExtensionRunner** | **38 次**（深度 woven） | **不剥离，保留 pi 的、空载运行**——`hasHandlers()` 全 false 时 emit 调用变近 no-op。这是关键判断：拆它要重写 `_emitExtensionEvent`/`_refreshToolRegistry`/`prompt` 的 hooks，得不偿失 | **零代码**（但要 vendor 它依赖的 runner/loader） |

**两个干净的接缝（无需 fork）**：

- **System prompt 注入**：`EvolveFlowResourceLoader.getSystemPrompt()` 返回上下文块。AgentSession 的 `_rebuildSystemPrompt`（agent-session.ts:907-941）会自动调它。
- **能力工具注入**：`createAgentSession({ customTools: [...] })`，pi-bridge 产出的 AgentTool 直接进 `_toolRegistry`（agent-session.ts:2307-2314）。

**关键约束**：`createCodingTools(cwd)` 会装 pi 原生工具，但它们的 `renderCall`/`renderResult` 依赖 `@earendil-works/pi-tui`（终端渲染，read.ts:4）。EvolveFlow 用 React，渲染那半用不到——但 `execute` 本身是纯的（只调 `ReadOperations.readFile`）。**策略**：vendor coding-agent/tools 整目录，删 render 相关 import（或让 render 返回空），保留 execute。这是比"自己写工具"省事的中间路线。

**净结论**：剥离现实可行，不会重写 AgentSession 一半。热路径（prompt/compaction/retry/事件）全保留。主要工作是 4 个适配器（ResourceLoader/ModelRegistry/SettingsManager + tools 整理）。详见附录 C 的逐调用点清单。

---

## 2. 一次典型交互的端到端数据流

### 2.1 场景选择

故意选一个**跨两类工具**的复杂场景，逼出架构的所有接缝：

> **用户说**："把昨天那个 PDF 要点整理进知识库，并建个复习任务。"

这个场景要 pi 原生工具（glob 找 PDF、read 读内容、write 写知识库）**和** EvolveFlow 能力工具（task.create 建任务）。如果架构只支持一类工具，这个场景就跑不通。

### 2.2 数据流序列图

```
React UI          Tauri/Rust        Node Sidecar            AgentSession             CapabilityRegistry   Storage(SQLite)
   │                  │                  │                       │                          │                    │
   │ 1.输入文本        │                  │                       │                          │                    │
   │─ai.stream(msg)─►│                  │                       │                          │                    │
   │                  │ 2.JSON-RPC stdin►│                       │                          │                    │
   │                  │                  │ 3.路由 handleAiStream  │                          │                    │
   │                  │                  │ 4.getHarness(sessionId)│                          │                    │
   │                  │                  │   (没建过就 new)       │                          │                    │
   │                  │                  │                       │                          │                    │
   │                  │                  │ 5.session.prompt(msg)►│                          │                    │
   │                  │                  │                       │ 6.createTurnState()      │                    │
   │                  │                  │                       │   • session.buildContext │                    │
   │                  │                  │                       │   • systemPrompt(cb)异步 │                    │
   │                  │                  │                       │     →buildConversation   │                    │
   │                  │                  │                       │      Context(db,reg)──────┼──────────────────►│
   │                  │                  │                       │     ←todayTasks,events,  │◄───────────────────│
   │                  │                  │                       │      dreamInsights...    │                    │
   │                  │                  │                       │   • resolve activeTools   │                    │
   │                  │                  │                       │ 7.executeTurn()           │                    │
   │                  │                  │                       │   • runAgentLoop(...)     │                    │
   │                  │                  │                       │     └ createStreamFn     │                    │
   │                  │                  │                       │       (正确接线)         │                    │
   │                  │                  │                       │                          │                    │
   │                  │                  │                       │ 8.streamSimple(model,ctx,│                    │
   │                  │                  │                       │   opts)→DeepSeek API     │                    │
   │                  │                  │◄──流式事件(t_start,──│                          │                    │
   │                  │                  │   text_delta,         │                          │                    │
   │                  │                  │   toolcall_*)         │                          │                    │
   │ ◄ai.stream_chunk─│◄─notification────│ (映射后)              │                          │                    │
   │  "让我先找昨天的PDF"│                 │                       │                          │                    │
   │                  │                  │                       │ 9.assistant 返回 toolCall │                    │
   │                  │                  │                       │   name:'glob'            │                    │
   │                  │                  │                       │   args:{pattern:'*.pdf'} │                    │
   │                  │                  │                       │                          │                    │
   │                  │                  │                       │10.prepareToolCall()      │                    │
   │                  │                  │                       │   • beforeToolCall hook  │                    │
   │                  │                  │                       │     →模式权限门+路径检查  │                    │
   │                  │                  │                       │   • pass                 │                    │
   │                  │                  │                       │11.tool.execute()         │                    │
   │                  │                  │                       │   →ExecutionEnv.listDir  │                    │
   │                  │                  │                       │     递归找 *.pdf         │                    │
   │                  │                  │                       │   ←[report.pdf,...]      │                    │
   │                  │                  │                       │12.afterToolCall hook     │                    │
   │                  │                  │                       │   →记 action_log(只读无) │                    │
   │                  │                  │                       │                          │                    │
   │ ◄ai.stream_chunk─│◄─notification────│ "找到 report.pdf"     │                          │                    │
   │                  │                  │                       │13.LLM 继续→toolCall read │                    │
   │                  │                  │                       │   →readTextFile(report)  │                    │
   │                  │                  │                       │   ←PDF 文本(或 OCR 结果) │                    │
   │                  │                  │                       │                          │                    │
   │                  │                  │                       │14.LLM 继续→toolCall      │                    │
   │                  │                  │                       │   task.create({          │                    │
   │                  │                  │                       │     title:'复习PDF要点', │                    │
   │                  │                  │                       │     due_date:'...'})     │                    │
   │                  │                  │                       │15.tool.execute()         │                    │
   │                  │                  │                       │   →pi-bridge:            │                    │
   │                  │                  │                       │    registry.invoke(      │                    │
   │                  │                  │                       │     'task.create',...)───┼──────────────────►│
   │                  │                  │                       │                          │ INSERT tasks       │
   │                  │                  │                       │                          │ INSERT action_log  │
   │                  │                  │                       │   ←{success,id:...}      │◄───────────────────│
   │                  │                  │                       │16.afterToolCall hook     │                    │
   │                  │                  │                       │   →记 action_log         │                    │
   │                  │                  │                       │     (含 toolCallId 幂等) │                    │
   │                  │                  │                       │                          │                    │
   │                  │                  │                       │17.LLM 继续→可能再 write  │                    │
   │                  │                  │                       │   知识库笔记 + 结束文本   │                    │
   │                  │                  │                       │18.agent_end              │                    │
   │                  │                  │                       │   →flushPendingWrites()  │                    │
   │                  │                  │                       │   →session.appendMessage │ (落 JSONL)        │
   │ ◄ai.stream_chunk─│◄─notification────│ "已创建复习任务，笔记  │                          │                    │
   │   {type:'done'}  │                  │  已存到知识库"        │                          │                    │
```

### 2.3 关键节点详解（带证据）

**节点 6（system prompt 注入）** — AgentSession 在每个 turn 经 `_rebuildSystemPrompt`（agent-session.ts:907-941）重建 prompt，调 `ResourceLoader.getSystemPrompt()`（:923）。我们的 `EvolveFlowResourceLoader` 在那里返回 `<evolveflow_context>`（内部调保留的 `buildConversationContext(db, registry)`，context.ts:36）+ persona。**这是注入点，不用改 pi 代码。**

**节点 8（streamFn 正确接线）** — 关键。AgentSession 经 Agent（L2）→ `runAgentLoop` → `streamSimple(model, context, options)`（agent-loop.ts:304）。streamFn 签名是 `(model, context, options)`，内部把 `getApiKeyAndHeaders`、provider hooks 全接好（sdk.ts:301-331）。**这正是 pi-engine.ts 写错的地方（C1）——用 AgentSession 后这个坑自动消失。**

**节点 10-12（工具执行三段式）** — agent-loop.ts 把每次 tool call 拆成三步：

- `prepareToolCall()`（agent-loop.ts:562-626）：找 tool、校验参数、调 `beforeToolCall` hook。返回 `{block:true,reason}` 会变 error tool result（:598-604）——**这是权限门的钩子。**
- `executePreparedToolCall()`（agent-loop.ts:628-669）：调 `tool.execute(toolCallId, args, signal, onUpdate)`（:637-655）。pi-bridge 的 execute 在这里转发到 `registry.invoke()`（pi-bridge/src/index.ts:104）。
- `finalizeExecutedToolCall()`（agent-loop.ts:671-714）：调 `afterToolCall` hook，可改写 content/details/isError/terminate（:694-702）——**这是审计/改写的钩子。**

**节点 16（幂等审计）** — pi-bridge 给每次 invoke 设了 `idempotency_key = agent:${session}:${toolCallId}`（pi-bridge/src/index.ts:106-108）。同一个 toolCallId 重试只会执行一次。配合 EvolveFlow 已有的 `action_log` 表，AI 发起的所有变更天然可审计可 undo。

**节点 18（持久化）** — AgentSession 的事件处理对 `message_end` 调 `sessionManager.appendMessage`（agent-session.ts:517-534）。Session 写到 JSONL 文件（jsonl-storage.ts:250-259，每行一个 entry，append-only）。**进程重启后 session 可完整重建。**

### 2.4 流式事件映射表（pi → EvolveFlow 前端）

EvolveFlow 前端现在只认一种 notification：`ai.stream_chunk`（sidecar.ts:925），payload 有 9 种 `type`（types.ts:217-227）。pi 的 `AgentEvent`（types.ts:408-423）+ AgentSession 自有事件（auto_retry/compaction 等）更细。**需要一层映射器**（~80 行，放 session-manager-bridge 里）：

| pi 事件                                                          | 当前 chunk.type                 | 映射动作                         |
| ---------------------------------------------------------------- | ------------------------------- | -------------------------------- |
| `agent_start` (agent-loop.ts:109)                                | `session_start`                 | 1 次，建会话上下文               |
| `turn_start` (agent-loop.ts:110/176)                             | —                               | 可并入 session_start             |
| `message_start`（assistant，agent-loop.ts:319/351）              | `text_delta`(首块)              | 开始一条 assistant 消息          |
| `message_update`（text_delta/thinking_delta，agent-loop.ts:334） | `text_delta` / `thinking_delta` | 增量文本/思考                    |
| `message_end`（assistant，agent-loop.ts:353/366）                | —                               | assistant 消息完成               |
| `tool_execution_start`（agent-loop.ts:407/462）                  | `tool_use_start`                | 开始工具调用                     |
| `tool_execution_update`（agent-loop.ts:643-653）                 | —                               | 工具进度（新能力，前端可选展示） |
| `tool_execution_end`（agent-loop.ts:723）                        | `tool_result`                   | 工具结果                         |
| `turn_end`（agent-loop.ts:218）                                  | —                               | 一轮结束                         |
| `agent_end`（agent-loop.ts:268）                                 | `done`                          | 整次运行结束，带最终 messages    |
| `before_agent_start`（AgentSession 经 ExtensionRunner emit）     | —                               | Dream/Memory 注入点              |
| 工具被 block（agent-loop.ts:598-604）                            | `error` 或新 `tool_blocked`     | 权限拒绝                         |

**当前没有、pi 也没有的**：`tool_permission_request`（types.ts:223）。pi 没有内置的"弹窗等用户确认"机制——它是通过工具调用 hook 同步返回 `{block}` 来控制。EvolveFlow 现在的 auto 模式弹窗确认（sidecar.ts:912-922 `confirmToolUse` + `waitForToolApproval`）是个**跨进程异步确认**，要挂在 AgentSession 的 hook 上（hook 是 sync-awaitable，可实现）。**见 §7.1 R1。**

### 2.5 与当前数据流的对比

| 环节       | 当前                                | 融合后                                                                                  |
| ---------- | ----------------------------------- | --------------------------------------------------------------------------------------- |
| 会话存储   | 内存 Map，重启全丢                  | JSONL 文件，重启可恢复（解 P0 缺口）                                                    |
| 上下文压缩 | 正则裁剪，曾丢 tool-use 配对        | AI 语义摘要，保留文件路径/决策/进度（compaction.ts:389-459 结构化模板）                 |
| 工具执行   | 手写 for 循环 + confirmToolUse 回调 | pi 并行/顺序执行（agent-loop.ts:384-388）+ before/afterToolCall hooks                   |
| 流式       | 手写 SSE 解析（client.ts）          | pi-ai 统一 provider 抽象，streamSimple（stream.ts:54-61）                               |
| Turn 管理  | 手写 maxTurns + auto-continuation   | pi inner/outer loop + steering/followUp 队列（agent-loop.ts:155-269）                   |
| 错误恢复   | try-catch 后 return error           | pi stopReason 机制 + failure message 编码（agent-loop.ts + AgentSession 的 auto_retry） |

---

## 3. pi 的哪些部分留、哪些砍

### 3.1 完整保留（100% 使用）

| 文件/模块                                                                                               | 路径（vendor 后）                                                | 理由                                                                                                                  | 证据                                                                                                 |
| ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **agent-loop.ts** (748L)                                                                                | `vendor-pi-agent/src/`                                           | L1 核心循环，Agent 内部用                                                                                             | agent-loop.ts:155-269                                                                                |
| **agent.ts** (557L)                                                                                     | `vendor-pi-agent/src/`                                           | L2 有状态 Agent，AgentSession 内部用                                                                                  | 整文件                                                                                               |
| **★ agent-session.ts** (3148L)                                                                          | `vendor-pi-coding-agent/src/core/`（**新增 vendor**）            | **L4 主角**。工具注册表 + system prompt 重建 + auto-compaction + retry + 事件订阅 + session 持久化。pi 自己的生产代码 | `_checkCompaction`:1812, `_runAutoCompaction`:1904, `_rebuildSystemPrompt`:907, `_buildRuntime`:2392 |
| **sdk.ts** (399L)                                                                                       | 同上                                                             | `createAgentSession()` 官方嵌入入口，我们要照抄                                                                       | sdk.ts:166-399                                                                                       |
| **tools/**（read/bash/edit/write/grep/find/ls + 索引）                                                  | `vendor-pi-coding-agent/src/core/tools/`（**新增 vendor**）      | pi 原生工具实现，工厂模式 `createReadTool(cwd)`                                                                       | tools/index.ts:117-196, read.ts, bash.ts, find.ts                                                    |
| **extensions/（runner+loader+types）**                                                                  | `vendor-pi-coding-agent/src/core/extensions/`（**新增 vendor**） | AgentSession 38 处依赖，空载运行；中期承载插件系统                                                                    | AgentSession 的 `_emitExtensionEvent` 等                                                             |
| **session-manager.ts / settings-manager.ts / model-registry.ts / resource-loader.ts / auth-storage.ts** | `vendor-pi-coding-agent/src/core/`（**新增 vendor**）            | AgentSession 协作对象。settings/model/resource 要写 stub 替换（§1.5）                                                 | —                                                                                                    |
| **types.ts** (agent, 423L)                                                                              | `vendor-pi-agent/src/`                                           | AgentMessage/AgentTool/AgentContext/AgentEvent                                                                        | types.ts:135-423                                                                                     |
| **types.ts** (harness, 833L)                                                                            | `vendor-pi-agent/src/harness/`                                   | FileSystem/ExecutionEnv/SessionRepo/Skill/事件类型                                                                    | types.ts:268-332                                                                                     |
| **session/**                                                                                            | `vendor-pi-agent/src/harness/session/`                           | Session 类 + JSONL 持久化 + memory 变体（测试）                                                                       | session.ts, jsonl-storage.ts:161-293                                                                 |
| **compaction/**                                                                                         | `vendor-pi-agent/src/harness/compaction/`                        | AI 语义摘要，**设计保护工具配对**（C8）                                                                               | compaction.ts:267-305, 389-459                                                                       |
| **messages.ts** (165L)                                                                                  | `vendor-pi-agent/src/harness/`                                   | convertToLlm + declaration merging 扩展点                                                                             | messages.ts:54-61, 120-164                                                                           |
| **system-prompt.ts / prompt-templates.ts / skills.ts**                                                  | 同上                                                             | Skill/模板格式化                                                                                                      | —                                                                                                    |
| **harness/env/nodejs.ts** (550L)                                                                        | 同上                                                             | Node.js ExecutionEnv（FileSystem+Shell）                                                                              | nodejs.ts:230-550                                                                                    |
| **整个 pi-ai 包**                                                                                       | `vendor-pi-ai/`                                                  | 模型/provider/streaming 抽象，含 DeepSeek（OpenAI 兼容）                                                              | openai-completions.ts:1187-1204                                                                      |
| ~~agent-harness.ts (1064L)~~                                                                            | vendor 保留但**不实例化**                                        | L3 半成品，作为 L4 内部依赖留着（它 import 了 compaction/session 等），但 EvolveFlow 不直接用                         | —                                                                                                    |

### 3.2 保留但需要适配（stub/适配器，不改 pi 代码）

| 协作对象                       | 适配方式                                                                                                      | 工作量 |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------- | ------ |
| ResourceLoader                 | 写 `EvolveFlowResourceLoader`，`getSystemPrompt()` 返回 `<evolveflow_context>`（调 buildConversationContext） | 小     |
| ModelRegistry                  | stub：`getApiKeyAndHeaders` 返回 DeepSeek key，`hasConfiguredAuth`→true，其余 no-op                           | 小     |
| SettingsManager                | stub：getters 返回固化默认（compaction=on/thinking=medium/shell=auto），setters 吞掉                          | 中     |
| ExtensionRunner                | **不 stub，保留 pi 的、空载运行**                                                                             | 零代码 |
| AuthStorage                    | 不直接耦合（0 次调用），忽略                                                                                  | 零     |
| tools/read.ts 等的 render 部分 | vendor 后删 `@earendil-works/pi-tui`/theme/keybinding import，或让 renderCall/renderResult 返回空             | 小     |

### 3.3 砍掉

**pi 工具一个不砍。** 前 AI 曾建议砍 bash/edit/read/grep——**大错**。CONTEXT.md §64-79 明确"接受个人日常事务向的能力扩展"，这些工具正是 AI 读 PDF/录音转写/搜笔记/写文件的手和眼。在它们基础上**加**能力工具，不是替换。

pi 仓库里要砍的是**编码场景的 UI/CLI 层**（保留 core/）：

| pi 部分                                                      | 处置      | 理由                                                     |
| ------------------------------------------------------------ | --------- | -------------------------------------------------------- |
| `coding-agent/src/modes/interactive/`（TUI 交互）            | 不 vendor | 桌面应用用 React                                         |
| `coding-agent/src/modes/rpc/`                                | 不 vendor | EvolveFlow 用 stdin/stdout JSON-RPC，不走 pi 的 RPC 模式 |
| `coding-agent/src/cli.ts / main.ts / package-manager-cli.ts` | 不 vendor | 不要 CLI 入口                                            |
| `coding-agent/src/bun/`                                      | 不 vendor | Bun 特定                                                 |
| `packages/tui/`（终端 UI 库）                                | 不 vendor | 不要 TUI                                                 |
| pi 自带的编码向 skill（`.agents/skills/`）                   | 不 vendor | EvolveFlow 有自己的                                      |
| 顶层 docs/scripts/examples                                   | 不 vendor | 精简                                                     |

### 3.4 新增（EvolveFlow 专属）

| 新增                                       | 说明                                                                     | 放哪                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| 能力工具（task._/event._/...）             | 经 pi-bridge 注册，作为 `customTools` 传给 createAgentSession            | `packages/evolveflow-pi-bridge/`（已有，7 测试通过）                   |
| AgentSession manager                       | Map<sessionId, session> + createAgentSession 包装 + 事件映射 + hook 注册 | `packages/evolveflow-runtime/src/ai/session-manager-bridge.ts`（新建） |
| EvolveFlowResourceLoader                   | 注入 `<evolveflow_context>` system prompt                                | 同上包内                                                               |
| EvolveFlowSettings / EvolveFlowModels stub | 固化默认值返回                                                           | 同上包内                                                               |
| 事件映射器                                 | pi AgentEvent → 9 种 ai.stream_chunk                                     | session-manager-bridge 内（~80 行）                                    |
| SQLite Session adapter（可选）             | 实现 SessionStorage 接口，与 JSONL 并存                                  | 中期，见 §7.3                                                          |

---

## 4. pi 工具如何与 EvolveFlow 场景适配

### 4.1 核心张力

pi 工具是为 **coding agent** 设计的：cwd 是项目根、git repo 边界天然限制操作范围、用户在终端能随时 Ctrl+C。EvolveFlow 是**个人生产力助手**：操作范围是用户整个 home、处理生活素材、跑在桌面 GUI 里。四件事要适配：cwd、文件范围、Shell、权限模型。

### 4.2 pi 原生工具的来源（这次读真实源码后更新）

**问题**：之前 vendor 只进了 agent + ai，没有工具实现。但这次重 clone pi 后，**完整的工具源码在手**（`coding-agent/src/core/tools/`，15 个 .ts 文件）。

**读源码后的真实情况**（修正初版的猜测）：

- 工具是**工厂模式**：`createReadTool(cwd, options)` 返回 `AgentTool`（read.ts:360-362），`execute` 签名 `(toolCallId, params, signal, onUpdate, ctx?)` 与 EvolveFlow pi-bridge 用的 `AgentTool` 接口**完全兼容**（tool-definition-wrapper.ts:5-19）。
- 工具**直接吃 `cwd`**，不依赖 coding-agent 的 CLI/权限系统。read.ts 的 `ReadOperations` 接口（read.ts:43-50）甚至**支持注入自定义读取后端**——EvolveFlow 可让它读 PDF、调 OCR。
- **耦合点**：read.ts 顶部 import 了 `@earendil-works/pi-tui`（read.ts:4，用于终端渲染）、theme、keybinding、`getReadmePath`。但 `execute` 本身只依赖 `ops.readFile`，**render 部分（renderCall/renderResult）才是耦合点**——而 EvolveFlow 用 React，根本用不到 render。

**结论：vendor coding-agent/tools 整目录，删 render 相关 import（或让 render 返回空），保留 execute。** 这比"自己写工具"省事得多（每个工具 200-400 行成熟代码），比"vendor 整个 coding-agent"又轻（不要 TUI/CLI）。`createCodingTools(cwd)` 一行就能拿到 read/bash/edit/write 四件套。

**MVP 建议**：起步用 `createReadOnlyTools(cwd)`（read+grep+find+ls，tools/index.ts:177-184），加能力工具。write/edit/bash 等真用到再加。

### 4.3 Windows Shell

**A 层（你自己用）非问题**：你装了 Git Bash，pi 的 `getShellConfig()`（nodejs.ts:162-195）能找到 `Git\bin\bash.exe`，bash 工具直接可用。

**B 层（开源分发）才要考虑**：分发给没装 Git Bash的用户时，bash 工具会 `shell_unavailable`。read/write/edit/grep/find/ls 是纯 Node fs（nodejs.ts:375-549），跨平台没问题。**应对**：B 层发版前再处理（文档提示需要 Git Bash，或打包精简 bash），不阻塞 A 层迁移。

### 4.4 文件范围限制（安全）

**问题**：pi 的 FileSystem 没有路径范围限制。在 coding 场景，git repo 边界天然限制；在 EvolveFlow 场景，cwd=home 意味着 AI 能读 `~/.ssh/id_rsa`、`~/.aws/credentials`。

**方案**：经 AgentSession 的工具调用 hook（ExtensionRunner 的 `before_tool_call`，§5.5）做路径/命令检查，返回 `{block:true,reason}` 会变 error tool result（agent-loop.ts:598-604）。

```typescript
// 注册到 AgentSession 的扩展 hook（见 §5.5 方案 A）
securityHook.on('before_tool_call', ({ toolName, input }) => {
  const sensitive = ['/.ssh/', '/.aws/', '/.gnupg/', '/AppData/Roaming/'];
  if (['read', 'write', 'edit'].includes(toolName)) {
    const p = String((input as any).file_path ?? '');
    if (sensitive.some((s) => p.includes(s))) {
      return { block: true, reason: `敏感路径被拦截: ${p}` };
    }
  }
  if (toolName === 'bash') {
    const cmd = String((input as any).command ?? '');
    if (/\b(rm\s+-rf\s+\/|format\s+[a-z]:|mkfs|dd\s+if=)/i.test(cmd)) {
      return { block: true, reason: '危险命令被拦截' };
    }
  }
  return undefined; // 不拦截
});
```

证据：agent-loop.ts:581-605（beforeToolCall 可 block）、:598-604（block 变 error tool result）。注：A 层（你自己用）敏感路径保护是可选的——你自己机器自己负责；B 层开源分发时启用。

### 4.5 权限模型（4 mode 矩阵）

EvolveFlow 当前有 4 个 AgentMode（chat/plan/auto/yolo，deepseek.ts:36 AgentMode）。pi 的 AgentSession 没有内置 mode 概念——**通过三处协同实现**：

| 协同点                                                                                                | 实现                                                                                      |
| ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `createAgentSession({ tools: [...] })` + `session.setActiveToolsByName()`（agent-session.ts:812-827） | 按 mode 过滤激活工具：chat 只给只读 + 不给能力工具；plan 给只读能力工具；auto/yolo 给全部 |
| `EvolveFlowResourceLoader.getSystemPrompt()`（§5.2）                                                  | persona 文案区分 mode（提取 sidecar.ts:1449-1532）                                        |
| ExtensionRunner `before_tool_call` hook（§5.5）                                                       | **最后防线**：即便 prompt 没拦住，hook 强制 block                                         |

mode 矩阵：

| mode | 只读工具(read/glob/grep) | 写工具(write/edit/bash)     | 能力工具(task.create 等) |
| ---- | ------------------------ | --------------------------- | ------------------------ |
| chat | ❌ block（无工具）       | ❌ block                    | ❌ block                 |
| plan | ✅ allow                 | ❌ block                    | 只读能力 ✅ / 写能力 ❌  |
| auto | ✅ allow                 | ⚠️ **需确认**（见 §7.1 R1） | 写能力 ⚠️ **需确认**     |
| yolo | ✅ allow                 | ✅ allow                    | ✅ allow                 |

### 4.6 cwd 适配

简单：`createAgentSession({ cwd: os.homedir() })`（sdk.ts:167）。所有相对路径都相对 home 解析（nodejs.ts:31-33 `resolvePath`）。

---

## 5. pi 内部哪些要改、怎么改（5 个接缝）

### 5.1 总原则

**F2 铁律：不重写，只适配。** vendor 进来的 pi 代码（agent + coding-agent/core）**不改热路径一行**，所有定制通过扩展点（适配器 / hooks / interfaces / declaration merging）接入。如果发现必须改 pi 代码才能做到的事，要么改方案，要么记成 ADR。

### 5.2 接缝 1：System Prompt 注入（经 ResourceLoader）

- **不改 pi 代码**。
- **方式**：写 `EvolveFlowResourceLoader implements ResourceLoader`，其 `getSystemPrompt()` 返回 `<evolveflow_context>` 块（调保留的 `buildConversationContext`）。AgentSession 的 `_rebuildSystemPrompt`（agent-session.ts:907-941）会自动调它并拼上工具列表。
- **证据**：agent-session.ts:923 `customPrompt = loader.getSystemPrompt()`、:924 `appendSystemPrompt = loader.getAppendSystemPrompt().join(...)`。

```typescript
// packages/evolveflow-runtime/src/ai/resource-loader.ts（新建）
class EvolveFlowResourceLoader implements ResourceLoader {
  constructor(
    private db: EvolveFlowDatabase,
    private registry: CapabilityRegistry,
    private mode: AgentMode
  ) {}
  async getSystemPrompt() {
    const ctx = await buildConversationContext(this.db, this.registry);
    return `${buildPersonaForMode(this.mode)}\n\n${renderEvolveFlowContext(ctx)}`;
  }
  getAppendSystemPrompt() {
    return [];
  }
  getSkills() {
    return [];
  } // 中期：注册排程 skill
  getAgentsFiles() {
    return [];
  }
  getPrompts() {
    return { prompts: [] };
  }
  getExtensions() {
    return { extensions: [] };
  }
  async extendResources() {}
  async reload() {}
}
```

### 5.3 接缝 2：会话存储（SessionManager）

- **默认用 pi 自带 JSONL**（SessionManager.create(cwd)），起步姿态完全隔离——pi 用 JSONL，EvolveFlow 业务库不动，零耦合。
- **存储位置**：`~/.evolveflow/sessions/`（与现有 `~/.evolveflow/app-data/` 同根）。`createAgentSession({ sessionManager: SessionManager.create(cwd) })` 一行接管。
- **`ai_sessions`/`ai_messages` 空壳表**：不碰（CONTEXT.md §198）。
- **SQLite adapter（可选，中期）**：实现 `SessionStorage` 接口（types.ts:440-454），每个 tree entry 存一行。何时做：当 Dream 要跨进程读历史对话时。MVP 不做。

### 5.4 接缝 3：上下文压缩（AgentSession 自动处理，无需自写触发）

- **不用自己写触发**——这是选 AgentSession 路线的关键收益。`_checkCompaction()`（agent-session.ts:1812）在每次 agent run 后（`_handlePostAgentRun`:979）和 prompt 前（:1079）自动检查；超阈值调 `_runAutoCompaction`（:1904）。
- **领域指令注入**：AgentSession 走的是 pi 的 `compact(preparation, model, ...)`（compaction.ts:633），customInstructions 可经 SettingsManager 的 compaction 配置传。但更简单：直接信赖 pi 默认 prompt（已经很结构化，compaction.ts:389-459 的 Goal/Constraints/Progress/Decisions 模板）。
- **关键正确性保证**（C8）：`findValidCutPoints`（compaction.ts:267-305）**显式排除 toolResult 作为切点**——压缩永远不会切断 assistant 工具调用与其结果。EvolveFlow 现在 150 行手写的 `adjustSplitForToolPairing`（loop.ts:774-927）可全部删除。

### 5.5 接缝 4：工具执行 + 审计 + auto 确认

**工具注入**：能力工具经 `createAgentSession({ customTools: [...] })`（sdk.ts:71），pi-bridge 产出的 `AgentTool` 进 `_toolRegistry`（agent-session.ts:2307-2314）。原生工具经 `createCodingTools(cwd)` 自动装。

**权限门 + auto 确认 + 审计**——全部挂在 AgentSession 的扩展系统上。AgentSession 每次工具调用经 ExtensionRunner 的 `before_tool_call` / `tool_result` hooks（不是 AgentHarness 的 `on()`）。**但因为我们要空载运行 ExtensionRunner**（§1.5），这些 hooks 怎么挂需要确认：

- **方案 A（首选）**：注册一个"内置扩展"（pi 扩展能注册 tool_call/tool_result hook），在 `createAgentSession` 前装好。扩展系统本是为此设计的。
- **方案 B（兜底）**：经 AgentSession 暴露的 hook 注册点（需读 agent-session.ts 确认有无 public hook API；若没有，回 A）。

```typescript
// auto 模式跨进程确认：复用现有 pendingToolApprovals Map + waitForToolApproval(120s)
// hook 内 await 同一个 promise（hook 是 sync-awaitable）
extensionRunner.on('before_tool_call', async ({ toolName, input }) => {
  if (!isMutating(toolName, input) || mode === 'yolo') return undefined;
  // 先发 tool_permission_request notification（保留现有 chunk 类型）
  sendNotification('ai.stream_chunk', { type: 'tool_permission_request', ... });
  const allow = await waitForToolApproval(approvalId);  // 120s 超时返 false
  return allow ? undefined : { block: true, reason: '用户拒绝' };
});
```

**幂等**：pi-bridge 已给能力工具设 `idempotency_key = agent:${session}:${toolCallId}`（pi-bridge/src/index.ts:106-108）。

### 5.6 接缝 5：sidecar 外壳（详见 §6）

保留 sidecar.ts 的 JSON-RPC 外壳和业务编排，内核从自研 loop 换成 AgentSession manager。

### 5.7 不需要改的 pi 部分

| 模块                     | 为什么不改                                  |
| ------------------------ | ------------------------------------------- |
| agent-loop.ts / agent.ts | 纯循环 + 状态，AgentSession 内部用          |
| agent-session.ts         | 热路径全保留，只换它的 4 个协作对象（§1.5） |
| session/session.ts       | 树结构，SessionManager 包它                 |
| compaction.ts            | AI 摘要 + 设计保护工具配对，直接用          |
| messages.ts              | convertToLlm + declaration merging 扩展     |
| 整个 pi-ai               | 模型抽象，完全不用改                        |

---

## 6. sidecar 如何对接 pi

### 6.1 目标：瘦身不重写

sidecar.ts 现在 1701 行。分类处置：

| 部分                                                                                                | 行数 | 处置                                                                                   |
| --------------------------------------------------------------------------------------------------- | ---- | -------------------------------------------------------------------------------------- |
| JSON-RPC 路由 + 业务方法（heartbeat/shutdown/rebuild*state/capability.*/dream._/buddy._/backup.\_） | ~700 | **保留**                                                                               |
| 4 mode system prompt（buildChat/Plan/Action，:1425-1532）                                           | ~110 | **提取**到 resource-loader.ts / persona.ts                                             |
| `initAiEngine`（:1534-1561）+ 自研 DeepSeek                                                         | ~30  | **删**，换成 session-manager-bridge 初始化                                             |
| `handleAiChat`/`handleAiStream`/`handleAiSuggestToday`（:743+, :844+, :975+）                       | ~400 | **重写**成调 AgentSession（chat 可并入 stream）                                        |
| session 状态 map + cancel/approve（:165-170, :195-201）                                             | ~80  | **保留** pendingToolApprovals（复用），删 streamControllers（AgentSession.abort 取代） |
| ai/loop.ts（1110 行）                                                                               | 1110 | **删**                                                                                 |
| ai/client.ts（504 行）                                                                              | 504  | **删**                                                                                 |
| ai/deepseek.ts（36 行）                                                                             | 36   | **改**，保留 DeepSeek 常量，删 Anthropic 端点常量                                      |
| ai/tools.ts（205 行）                                                                               | 205  | **退役**（pi-bridge + createCodingTools 取代）                                         |
| ai/context.ts（375 行）                                                                             | 375  | **完整保留**（resource-loader 调它）                                                   |
| ai/types.ts（309 行）                                                                               | 309  | **保留** ConversationContext/AiStreamChunk（映射用）                                   |
| pi-engine.ts（146 行）                                                                              | 146  | **删**（C1 已证失败）                                                                  |
| orchestrators（dream.ts 904 + buddy.ts 418）                                                        | 1322 | **保留**；Dream 需把 ApiClient 换成 pi `completeSimple`                                |

**目标**：sidecar.ts 从 1701 → ~600-700 行。

### 6.2 新 sidecar AI 路径骨架

```typescript
// packages/evolveflow-runtime/src/ai/session-manager-bridge.ts（新建）
import { createAgentSession } from '@evolveflow/vendor-pi-coding-agent/sdk';
import { SessionManager } from '@evolveflow/vendor-pi-coding-agent';
import { getModel } from '@evolveflow/vendor-pi-ai';
import { capabilitiesToAgentTools } from '@evolveflow/pi-bridge';
import { EvolveFlowResourceLoader } from './resource-loader.js';
import { EvolveFlowSettings } from './settings-stub.js';
import { EvolveFlowModels } from './models-stub.js';
import { mapAgentEventToStreamChunk } from './event-mapper.js';

const sessions = new Map<string, AgentSession>();
const pendingToolApprovals = new Map<string, { resolve; timeout }>(); // 复用现有

export async function getOrCreateSession(
  sessionId: string,
  mode: AgentMode,
  db: EvolveFlowDatabase,
  registry: CapabilityRegistry,
  apiKey: string
): Promise<AgentSession> {
  if (sessions.has(sessionId)) return sessions.get(sessionId)!;

  const cwd = os.homedir();
  const model = getModel('deepseek', 'deepseek-v4-pro'); // 真实 id，已验证
  const capabilityTools = capabilitiesToAgentTools(registry, {
    actor: 'ai',
    origin: 'ai_page',
    session_id: sessionId,
  }).map((t) => createToolDefinitionFromAgentTool(t)); // 转 ToolDefinition 给 customTools

  const { session } = await createAgentSession({
    cwd,
    model,
    sessionManager: SessionManager.create(cwd), // JSONL 自动持久化
    resourceLoader: new EvolveFlowResourceLoader(db, registry, mode), // 注入 <evolveflow_context>
    settingsManager: new EvolveFlowSettings(), // stub，返回固化默认
    modelRegistry: new EvolveFlowModels(apiKey), // stub，getApiKeyAndHeaders 返回 DeepSeek
    customTools: capabilityTools, // 能力工具
    // pi 原生工具经 createCodingTools(cwd) 自动装（createAgentSession 默认行为）
    tools: filterActiveToolNamesByMode(mode, capabilityTools), // 按 mode 激活
  });

  // 装权限/审计/确认 hook（经扩展系统，见 §5.5）
  registerSecurityAndApprovalHooks(session, mode, pendingToolApprovals);

  // 事件 → JSON-RPC notification
  session.subscribe((event) => {
    sendNotification('ai.stream_chunk', mapAgentEventToStreamChunk(event, sessionId), requestId);
  });

  sessions.set(sessionId, session);
  return session;
}
```

### 6.3 ai.stream handler 重写

```typescript
async function handleAiStream(request, params, traceId) {
  if (!apiKey) return errorResponse('AI engine not initialized');
  const sessionId = params.session_id || crypto.randomUUID();
  const mode = resolveAgentMode(params.mode, 'auto');
  const session = await getOrCreateSession(sessionId, mode, _db!, _registry!, apiKey);
  // AgentSession.prompt() 返回 Promise<void>；流式事件经 subscribe 异步推送
  setImmediate(async () => {
    try {
      await session.prompt(params.message);
      // done 事件由 agent_end → mapper 发出
    } catch (err) {
      sendNotification(
        'ai.stream_chunk',
        { type: 'error', error: String(err), session_id: sessionId },
        request.request_id
      );
    }
  });
  return { jsonrpc: '2.0', id: request.id, result: { session_id: sessionId, streaming: true } };
}
```

### 6.4 兼容/迁移策略（feature flag）

步骤 4 之前**双路径**，用 env flag 切，留逃生通道：

```typescript
if (method === 'ai.stream') {
  return process.env.EVOLVEFLOW_USE_PI === '1'
    ? handleAiStreamPi(request, params, traceId)
    : handleAiStreamLegacy(request, params, traceId);
}
```

---

## 7. 诚实的风险和未解决问题

### 7.1 中风险（要处理但不阻断）

#### R1 · auto 模式的跨进程异步确认（hook 挂载点待确认）

**问题**：EvolveFlow 当前 auto 模式在调写工具前弹窗确认（sidecar.ts:912-922 `confirmToolUse` + `waitForToolApproval` 120s 超时）。迁到 pi 后，要挂在 AgentSession 的工具调用 hook 上。**但 AgentSession 用的是 ExtensionRunner 的 hook 系统（38 处依赖），不是 AgentHarness 的 `on()`**——具体怎么注册一个"内置 hook"需要在实现期确认（§5.5 方案 A/B）。

**好消息**：pi 的 hook 是 sync-awaitable 的（agent-loop.ts:582-590），所以跨进程确认**语义上完全能实现**——hook 内 await `waitForToolApproval` 那个现成 promise，循环会暂停等用户点确认。pendingToolApprovals Map 和 ai.approve_tool 方法都能复用。**这是降级后的判断**：从"高风险"降到"实现期要确认挂载点"。

#### R2 · DeepSeek 端点格式切换（Anthropic → OpenAI 兼容）

**A 层非问题**：pi-ai 的 DeepSeek provider 用 OpenAI 兼容端点（`https://api.deepseek.com`，openai-completions.ts:505），DeepSeek 本来就主推这个端点。EvolveFlow 现在用的 Anthropic 兼容端点反而是非主流。

**迁移要注意**：(a) tool calling 的 wire format 从 Anthropic `tool_use`/`tool_result` 切到 OpenAI `tools`/`tool_calls`（pi-ai 的 `convertMessages` openai-completions.ts:819+ 自动转）；(b) `cache_control: ephemeral`（sidecar.ts:1445）会失效，改用 pi-ai 的 `cacheRetention`（DeepSeek OpenAI 端点缓存支持有限，影响小）；(c) thinking 由 pi-ai 自动开 `thinkingFormat: "deepseek"`（openai-completions.ts:1202-1204），比手写稳。

**验证**：smoke test 要扩成多轮工具调用，确认 OpenAI 端点下 tool calling 成功率。

#### R3 · AgentSession 的 5 个协作对象剥离

见 §1.5 的逐对象工作量。**净结论**：剥离现实可行（4 个 stub 适配器 + 1 个保留空载），不会重写一半。主要工作量在 SettingsManager（22 次调用，~15 方法，多数是 getter）和 ExtensionRunner（保留 pi 的）。附录 C 有逐调用点清单。

#### R4 · Windows Shell（仅 B 层开源分发）

A 层（你自己用）非问题——你装了 Git Bash。B 层发版前处理（文档提示 / 打包精简 bash），不阻塞迁移。read/write/edit/grep/find/ls 是纯 Node fs，跨平台无忧。

#### R5 · Dream 系统与 ApiClient 耦合

DreamOrchestrator（dream.ts:227）构造时吃 `ApiClient`（dream.ts:236），删 client.ts 会断 Dream。**必须**：Dream 的 AI 调用换成 pi 的 `completeSimple`（stream.ts:63-70）。隐性工作项，PRD 要单列。

### 7.2 低风险 / 已知但可接受

#### R6 · JSONL Session 性能

JSONL append-only，长会话大文件，`getPathToRoot`（jsonl-storage.ts:275-288）要遍历到根。**缓解**：AgentSession 自动 compaction 减少消息量；`readTextLines` 支持 `maxLines`；中期 SQLite adapter。

#### R7 · getModel 返回 undefined

`getModel`（models.ts:20-26）对未知 id 返回 `undefined`（C6），后续属性访问才抛 TypeError。不影响正确性（正确 id 会 work），建议 session-manager-bridge 显式判空。

#### R8 · F2 不追上游

ADR-0006 已接受。安全补丁自盯，关键修复可 cherry-pick。

### 7.3 待用户决策的问题

1. **Session 存储**——JSONL 起，还是直接 SQLite adapter？**推荐 JSONL 起**，SQLite 等 Dream 要读历史时再做。
2. **Agent mode 数量**——保留 4 个（chat/plan/auto/yolo）还是简化？**推荐保留 4 个**（plan 对排程只读有价值，yolo 对信任用户有价值）。
3. **Skill 双轨制**——EvolveFlow 已有 40+ skill（多 human-only），哪些注册为 pi skill？**推荐初期只注册排程相关**（已有 `skills/schedule-skill.ts`）。
4. **pi 原生工具起步范围**——`createReadOnlyTools`（read+grep+find+ls）起，还是直接全装？**推荐只读起**，write/edit/bash 等用到再加。

（注：相比初版，R1/R2/R4 都从"高风险"降级了——因为它们对 A 层不是真问题；新增 R3 是 AgentSession 路线的真实工作量，不藏。）

---

## 8. 对 PRD 8 步的修订

| 步             | PRD 原描述                                     | 修订后                                                                                                         | 关键变化                               |
| -------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| 0              | 拉 pi 源码（只 vendor agent+ai，然后 rm 缓存） | ✅ 完成；**这次重 clone 并保留缓存**（C4）                                                                     | 别再 rm                                |
| 1              | vendor agent+ai 包                             | ✅ 完成                                                                                                        | —                                      |
| 2              | pi-bridge 桥接骨架                             | ✅ 完成（7 测试通过）                                                                                          | —                                      |
| **2a**（新增） | —                                              | **vendor coding-agent/src/core/（agent-session + tools + extensions + managers）**，删 TUI/CLI/modes 的 import | 这是 L4 路线的前提                     |
| **3**          | 写 pi-engine.ts 包装 harness                   | **❌ 删 pi-engine.ts，改写 session-manager-bridge.ts**                                                         | 用 L4 `AgentSession` 不用 L1/L3。修 C1 |
| **3a**（新增） | —                                              | **写 4 个适配器**：EvolveFlowResourceLoader / Settings stub / Models stub + 删工具的 render import             | 解 R3                                  |
| **3b**（新增） | —                                              | **写 event-mapper.ts**：pi AgentEvent → 9 种 ai.stream_chunk                                                   | 保留前端契约                           |
| 4              | 删自研循环，迁移测试                           | 删 loop/client/deepseek/pi-engine/tools.ts，保留 context/types，重写 ai.test.ts                                | 同原 PRD                               |
| **5**          | 会话持久化 + 前端读历史                        | **AgentSession 自动 JSONL 持久化，前端改读 pi 历史**                                                           | pi 自动做                              |
| **6**          | 预装 pi-memctx                                 | **推迟**——先稳定核心                                                                                           | 降优先级                               |
| **7**          | 清理打包                                       | 删 vendor 进来但不用的 modes/cli/tui                                                                           | 比原 PRD 多了要删的                    |
| **8**（新增）  | —                                              | **Dream 解耦 ApiClient + 接 pi completeSimple**                                                                | 解 R5                                  |

**步骤 3 的具体重写**（取代 pi-engine.ts）：

```bash
# 删失败的 pi-engine.ts
rm packages/evolveflow-runtime/src/pi-engine.ts
rm packages/evolveflow-runtime/tests/pi-engine-smoke.test.ts

# 新建（L4 路线）
# packages/evolveflow-runtime/src/ai/session-manager-bridge.ts  (~250 行)
# packages/evolveflow-runtime/src/ai/resource-loader.ts         (~120 行)
# packages/evolveflow-runtime/src/ai/settings-stub.ts           (~100 行)
# packages/evolveflow-runtime/src/ai/models-stub.ts             (~60 行)
# packages/evolveflow-runtime/src/ai/event-mapper.ts            (~100 行)
# packages/evolveflow-runtime/tests/session-bridge.test.ts      (~120 行)
```

**步骤 3 验证标准**：

- `npm run build` 通过
- session-bridge 单元测试：用 `SessionManager.inMemory()`（sdk.ts:162 示例）跑无 IO 测试，验证 prompt→tool call→result 闭环
- smoke test：真 DeepSeek，发"列出今天的任务"→AI 调 `task.list`→返回真实任务。**响应内容必须非空**（pi-engine.ts 没达到的）

---

## 附录 A：源码阅读清单（本人逐行读过）

| 文件                                                     | 行数 | 关键发现                                                                                        |
| -------------------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------- |
| `vendor-pi-agent/src/harness/agent-harness.ts`           | 1064 | L3 半成品。executeTurn:553-628。**全仓仅测试用过**（C7）                                        |
| `vendor-pi-agent/src/agent-loop.ts`                      | 748  | L1 循环。streamFn(model,ctx,opts):304；beforeToolCall block:598-604                             |
| `vendor-pi-agent/src/harness/types.ts`                   | 833  | 全部接口。SessionStorage:440-454                                                                |
| `vendor-pi-agent/src/harness/session/session.ts`         | 266  | Session 树                                                                                      |
| `vendor-pi-agent/src/harness/session/jsonl-storage.ts`   | 293  | JSONL 持久化                                                                                    |
| `vendor-pi-agent/src/harness/compaction/compaction.ts`   | 762  | **findValidCutPoints 排除 toolResult:283-284（C8 保护配对）**；customInstructions:478-479       |
| `vendor-pi-agent/src/harness/messages.ts`                | 165  | convertToLlm:120-164；declaration merging:54-61                                                 |
| `vendor-pi-agent/src/types.ts`                           | 423  | AgentTool:366-389                                                                               |
| `vendor-pi-agent/src/harness/env/nodejs.ts`              | 550  | Windows bash 依赖:162-195；fs 跨平台:375-549                                                    |
| `coding-agent/src/core/agent-session.ts`                 | 3148 | **L4 主角**。prompt:997；\_checkCompaction:1812；\_rebuildSystemPrompt:907；\_buildRuntime:2392 |
| `coding-agent/src/core/sdk.ts`                           | 399  | `createAgentSession()` 嵌入入口                                                                 |
| `coding-agent/src/core/tools/index.ts`                   | 197  | `createCodingTools`/`createReadOnlyTools` 工厂                                                  |
| `coding-agent/src/core/tools/read.ts`                    | 363  | 工厂模式；ReadOperations 可注入；耦合 pi-tui(render)                                            |
| `coding-agent/src/core/tools/tool-definition-wrapper.ts` | 46   | wrapToolDefinition: ToolDefinition→AgentTool                                                    |
| `agent/docs/agent-harness.md`                            | 487  | **自陈半成品**：TODO #2/#3/#4/#5/#7 未完成（C7 证据）                                           |
| `runtime/src/sidecar.ts`                                 | 1701 | 4 mode prompt:1425-1532；ai.stream:844+；confirmToolUse:912-922                                 |
| `runtime/src/ai/loop.ts`                                 | 1110 | 手写循环 + 150 行 tool-pairing 补救:774-927（C8 对照）                                          |
| `runtime/src/ai/context.ts`                              | 375  | **保留**。buildConversationContext:36                                                           |
| `runtime/src/pi-engine.ts`                               | 146  | **失败**。streamFn 错:127-134（C1）。将删                                                       |
| `pi-bridge/src/index.ts`                                 | 140  | capability→AgentTool；idempotency_key:106-108                                                   |
| `vendor-pi-ai/.../openai-completions.ts`                 | —    | DeepSeek 走 OpenAI 端点:1187-1204                                                               |
| `vendor-pi-ai/.../models.ts` + `models.generated.ts`     | —    | getModel 返 undefined:20-26；deepseek-v4-pro 真实:3835-3874                                     |
| `vendor-pi-ai/stream.ts`                                 | —    | streamSimple(model,context,options):54-61                                                       |

## 附录 B：Explore agent 调研结论摘要

四个并行 Explore agent 的产出（已融入正文）：

1. **(首轮) coding-agent 缓存为空** → C4，触发重 clone。
2. **runtime 全景** → sidecar 1701 行逐方法分类、orchestrators 耦合点、9 种 AiStreamChunk 契约、tool-pairing 补救逻辑。
3. **pi-ai DeepSeek 真相** → C3：OpenAI 端点不是 Anthropic；deepseek-v4-pro 真实；streamSimple 签名证 C1。
4. **(二轮) AgentSession 耦合测绘** → §1.5 的 5 协作对象逐调用点；ExtensionRunner 38 处（保留空载）；ResourceLoader/Models 是薄边界；auto-compaction 确认成熟。
5. **(二轮) sidecar AI 路径全貌** → confirmToolUse 跨进程 promise 机制；AiStreamChunk 9 种 type 全列；runConversation options→pi 映射表。

## 附录 C：AgentSession 5 协作对象逐调用点（剥离清单）

来自 Explore agent 测绘（agent-session.ts 行号）：

- **AuthStorage**：0 次。不耦合。
- **ResourceLoader**（8 次）：getSystemPrompt(:923)、getAppendSystemPrompt(:924)、getSkills、getAgentsFiles、getPrompts、getExtensions、extendResources、reload。写适配器注入 `<evolveflow_context>`。
- **ModelRegistry**（9 次，6 方法）：getApiKeyAndHeaders(:371,:402,:1917)、isUsingOAuth(:382,:1066)、hasConfiguredAuth(:1065,:1454,:1484,:2248)、getAvailable(:1513)、find(:2176)、registerProvider(:2288)、unregisterProvider(:2292)。stub：只让 getApiKeyAndHeaders + hasConfiguredAuth 真工作。
- **SettingsManager**（22 次，~15 方法）：getRetrySettings、setDefaultModelAndProvider、setDefaultThinkingLevel、getDefaultThinkingLevel、getSteeringMode、getFollowUpMode、setSteeringMode、setFollowUpMode、getCompactionSettings(:1666,:1813,:1905)、setCompactionEnabled、getCompactionEnabled、getImageAutoResize、getShellCommandPrefix、getShellPath、reload、getRetryEnabled、setRetryEnabled、getBranchSummarySettings、getTheme、isProjectTrusted。stub：getter 返固化默认，setter 吞掉。
- **ExtensionRunner**（38 次）：深度 woven 于 \_emitExtensionEvent、prompt 的 input/before_agent_start hook、compaction 的 session_before_compact、\_refreshToolRegistry、\_bindExtensionCore、dispose、reload。**不剥离，保留空载**。

---

> **规划完成（v2，AgentSession 路线）。** 基于对 pi 全仓（agent 1064L harness + 748L loop + 833L types + 762L compaction + coding-agent 3148L agent-session + 399L sdk + tools/ + agent-harness.md 487L 文档）和 EvolveFlow（1701L sidecar + 1110L loop + 375L context + 146L pi-engine + 140L pi-bridge）核心源码的逐行阅读，加 5 个并行/串行 Explore agent 的交叉验证，加 2 次关键事实核实（工具配对保护 C8、AgentHarness 是否被生产使用 C7）。
>
> **核心结论（v2，修正 v1 的 C7 错误）**：
>
> 1. ~~用 AgentHarness（L3）~~ → **用 Agent + AgentSession（L4），pi 自己的生产路线**。AgentHarness 是半成品。
> 2. pi 工具**一个不砍**，全留（vendor coding-agent/tools，删 render 耦合）并新增能力工具。
> 3. pi-bridge 继续用。
> 4. 工具配对保护由 pi 设计层面解决（C8），EvolveFlow 150 行手写补救可删。
> 5. 主要工作：vendor coding-agent/core + 写 4 个适配器（§1.5）+ event-mapper + 删 pi-engine/loop/client。
> 6. 真问题（降级后）：R1 hook 挂载点（实现期确认）、R2 DeepSeek 端点切换、R3 协作对象剥离、R5 Dream 解耦。**无致命风险。**
>
> 下一步：等用户对 §7.3 的 4 个决策点拍板，再进 PRD 修订 + `/implement`。
