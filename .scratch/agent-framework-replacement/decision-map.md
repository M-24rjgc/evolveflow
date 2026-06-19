# Decision Map: 替换 AI Runtime 底座

> 目标：用 F2 方式（fork 一次、自己接管、不追上游、复制改造不重写）
> 选定并接入一个成熟的 Agent 框架，替换当前自研 runtime。
>
> **评判北极星**（来自 CONTEXT 愿景 + ADR-0006）：
>
> - 必须原生支持 Skill 和 MCP 调用
> - 必须支持多 Agent 模式（内置 chat/plan/auto/yolo + 插件动态注册新模式）
> - 架构要好（深模块、可扩展），便于承载未来的"插件=能力包"系统
> - 能被 Tauri 桌面应用嵌入或作为 sidecar（Node.js 生态）
> - 不和"本地优先、单用户"冲突；企业级/多用户功能可接受（会被砍掉）
> - 选型哲学：F2（fork 改造，不重写，不追上游）——见 ADR-0006
>
> **保留不动的资产**：domain / storage / capabilities 三层（EvolveFlow 护城河）。
> **要替换的**：runtime 层的 AI 编排（loop/client/tools/session/调度器）。

---

## 已 inline 解决的决策

### 框架使用方式：F2（Fork 一次，自己接管）

- **Answer**：见 ADR-0006。fork 改造，不重写，不追上游，企业级功能可砍。
- **影响**：候选范围扩大到"架构好但社区小"的框架；不因上游活跃度一票否决。

### 保留的 EvolveFlow 特色（不能丢）

- **Answer**：tool_use ↔ capability 双向映射（tools.ts 的纯函数适配）、
  幂等键机制（tool_use_id 去重）、对话压缩的 tool_use/tool_result 配对保护、
  Dream 系统的离线分析入口。这些是 EvolveFlow 特有的，框架不会自带，迁移时要保住。

---

## #1: 候选框架的真实盘点

Blocked by: （无，这是 frontier）
Type: Research

### Question

用户提到的候选（yuxi、OpenClaudeCode、codex、pi、hermes、LangChain/LangGraph、
deepagent）以及其他主流 TS Agent 框架，它们各自到底是什么？
定位、架构、能力、许可证、是否 TS/Node、是否支持 Skill+MCP、社区状态如何？

需要把名字查实（有些可能是记混的名字），产出一份候选清单+事实卡片，
作为后续 ticket 的对比基础。

### Answer

调研于 2026-06-20，来源 WebSearch + 官方仓库/文档交叉确认。

#### A. 名字核实（用户提到的 6 个名字）

| 名字               | 真实所指                                                                                                                                                             | 语言                    | 许可证                         | 与愿景关联度                                |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | ------------------------------ | ------------------------------------------- |
| **yuxi**           | ❌ **查无此项目**。唯一命中的 `wilson0523/Yuxi-Know` 是小规模知识图谱平台，不符"企业级架构好"。最可能是记混——特征指向 Mastra / VoltAgent，或把 pi 的"自扩展"特征串台 | —                       | —                              | 低（需用户补线索）                          |
| **OpenClaudeCode** | ⚠️ 名字记混。真实所指 `ruvnet/open-claude-code`（基于泄露源码重建的 CLI）或 `Gitlawb/openclaude`                                                                     | TS                      | 未确认（泄露源码有 DMCA 风险） | 中                                          |
| **codex**          | ✅ `openai/codex`（OpenAI Codex CLI）                                                                                                                                | **Rust**                | Apache 2.0                     | 中（本地编码 agent，但非"造 agent 的框架"） |
| **pi**             | ✅ agent 语境下指 `earendil-works/pi`（**非** Inflection 的 Pi）                                                                                                     | **TS/Node**             | 未确认                         | **高**                                      |
| **hermes**         | ✅ `NousResearch/hermes-agent`（自改进 agent + 技能生态）                                                                                                            | 未确认                  | 未确认                         | 中（偏重）                                  |
| **deepagent**      | ✅ `langchain-ai/deepagents`（LangChain 官方，研究 Claude Code/Manus 后提炼）                                                                                        | **Python**（LangGraph） | 疑 MIT                         | 中（绑定 LangChain + Python）               |

#### B. 主流 TS Agent 框架事实卡片（对照查证补充）

| 框架                       | 许可证     | TS原生         | MCP支持                 | 内置持久化     | 依赖轻量 | 平台/云痕迹      | 综合匹配 |
| -------------------------- | ---------- | -------------- | ----------------------- | -------------- | -------- | ---------------- | -------- |
| **Vercel AI SDK**          | **MIT**    | ✅最纯         | ✅原生(v5稳定)          | ❌需自建       | ✅最轻   | 几乎无           | **最高** |
| **LangChain/LangGraph.js** | MIT        | ✅(Python二等) | ✅adapter包             | ✅checkpointer | 🟡偏重   | LangSmith(可选)  | 中       |
| **Mastra**                 | ⚠️**ELv2** | ✅             | ✅**双向client+server** | ✅memory系统   | 🟡中等   | 较多(+ELv2)      | 中偏低   |
| **LlamaIndex.ts**          | MIT        | ✅(生态最小)   | ✅connector级           | 🟡弱           | 🟡偏重   | LlamaParse(可选) | 偏低     |

#### C. 关键判断

1. **`earendil-works/pi`** 是用户名单里关联度最高的：本地优先、TS 扩展、
   自扩展编码 agent、可接本地模型——与"个人本地优先 AI 助手"逐条对齐。
   **但需查证**：许可证、是否原生 MCP、架构成熟度、社区规模。
2. **Vercel AI SDK** 是主流框架里匹配度最高的：MIT、TS 原生、MCP 原生、最轻、无平台包袱。
   唯一短板：无内置持久化记忆（需自补，但 EvolveFlow 已有 SQLite + ai_sessions 表）。
3. **Mastra** 功能最全（MCP 双向 + memory + workflow），但 **ELv2 协议**
   对"分发给用户本地"的桌面应用是真实风险，且 ADR-0006 的 F2 fork 改造
   可能与 ELv2 条款冲突（ELv2 限制移除 license key 等保护机制）。
4. **yuxi 查无此项目**——#2 筛选前需用户补线索，或直接排除。

#### D. 进入 #2 的候选清单（收敛后）

按关联度排序，#2 将聚焦对比：

1. **earendil-works/pi**（需补查许可证/MCP/架构）
2. **Vercel AI SDK**（主流首选）
3. **LangGraph.js**（备选，需 graph 化多 agent 才值得）
4. ~~Mastra~~（ELv2 风险，除非许可证确认 OK 再纳入）
5. ~~LlamaIndex.ts~~（除非愿景以 RAG 为核心）

#### E. 待用户确认的开放问题

- **yuxi 到底是什么？** 用户能否补一条线索（中/英文、在哪看到、有无 MCP/RAG 特征）？
  若想不起来，直接排除，不影响 #2 推进。

#### F. 补充核实：xerrors/Yuxi（用户给出确切链接）

用户补了链接 `github.com/xerrors/Yuxi`，它是真实存在的项目。

- **定位**：多租户智能体开发平台（Agent Harness），整合 RAG + Milvus 知识库 +
  知识图谱 + LangGraph 多智能体编排。是**平台/应用**，非纯框架。
- **技术栈**：前端 Vue3，**后端 Python（FastAPI + LangGraph v1）**，非 TS/Node。
- **企业级痕迹（用户要砍的全中）**：多租户是渗透式设计（前端路由守卫 +
  后端认证中间件 + 数据查询 tenant 维度散落各层），单租户化是跨多层重构。
- **依赖栈重**：PG + Redis + MinIO + Milvus + Neo4j 五大服务，Docker Compose 优先。
- **许可证**：⚠️ 未直接读到 LICENSE，需用户亲自核对（硬前提）。
- **结论**：架构/功能确实好（monorepo + 两份架构文档 + 扩展点齐全），
  但有三个硬卡点：(1) 许可证未核实 (2) 多租户渗透式难砍 (3) Python+重 Docker 栈
  与"个人本地优先 TS 桌面应用"根本性冲突。
- **影响 #2**：Yuxi 作为整体 fork 底座**不合适**（栈冲突 + 砍改成本过高），
  但其**知识图谱/RAG/AgenticRAG 的设计思路值得借鉴**。

---

## #2: 哪个框架最匹配评判北极星（含砍改可行性）

Blocked by: #1
Type: Discuss

### Question

基于 #1 的候选清单，对照评判北极星逐个打分。
特别关注：砍掉企业级/多用户功能的可行性（隐藏耦合？）、
是否原生支持"插件动态注册新 Agent 模式"、TS/Node 嵌入桌面 sidecar 的成本。
最终收敛到 1-2 个首选 + 备选。

### Answer

**决定：选用 `earendil-works/pi` 作为 Agent runtime 底座。**

#### 决赛对比

| 维度           | **pi（earendil-works）**    | Vercel AI SDK           | Yuxi(xerrors)      |
| -------------- | --------------------------- | ----------------------- | ------------------ |
| 许可证         | ✅ **MIT**                  | ✅ MIT                  | ⚠️ 未核实          |
| 语言/栈        | ✅ **TS/Node**              | ✅ TS                   | ❌ Python+重Docker |
| 本地优先       | ✅ 核心设计理念             | 🟡 中性(偏云SDK)        | ❌ 五大服务依赖    |
| 形态           | ✅ **harness(骨架)**        | ❌ library(砖头)        | 平台               |
| MCP            | 🟡 扩展提供                 | ✅ 原生                 | ✅ 有              |
| 扩展/插件系统  | ✅ **一等公民,热重载**      | ❌ 无(要自建)           | 🟡 有但绑定平台    |
| 动态注册新模式 | ✅ **扩展可注册mode**       | ❌ 无                   | 🟡                 |
| 会话持久化     | ✅ **核心一等公民**         | ❌ 需自建               | ✅                 |
| 记忆生态       | ✅ **4173+包,记忆/RAG齐备** | ❌ 无                   | ✅ 自带            |
| 嵌入桌面       | ✅ **SDK+RPC双路径**        | ✅                      | ❌ Docker          |
| 砍改难度       | 🟡 砍CLI层(轻)              | ✅ 不用砍               | ❌ 多租户渗透式    |
| **综合**       | **🏆 胜出**                 | 备选(自建harness成本高) | 排除(栈冲突)       |

#### 为什么是 pi（关键论据）

1. **哲学同构**：pi 的"最小核心 + 扩展即能力"与 EvolveFlow 的"插件=能力包"
   几乎是同一个理念的两种表述。pi 扩展能注册 tool/mode/command/prompt，
   这正是 EvolveFlow 想要的"能力包"。
2. **harness 非 library**：用户明确指出"Vercel 的话 harness 不好写"——正确。
   pi 是骨架（有完整的 agent 运行循环、会话引擎、事件总线），拿来改；
   Vercel AI SDK 是砖头（要自己砌 harness），违背 ADR-0006"不重写"。
3. **MIT + TS + 本地优先**：三个硬指标全中。
4. **拿来主义机会大**：pi-memctx（记忆/RAG）、context-mode（MCP+上下文压缩）、
   pi-context-tools 等可直接预装；EvolveFlow 的日程/任务能力作为 pi 扩展开发，
   还能反哺 pi 生态。
5. **会话持久化是核心一等公民**：补上了 EvolveFlow 当前最大的缺口
   （自研 runtime 的 ai_sessions 表建了从不写入）。

#### pi 的已知短板及应对

| 短板                                 | 应对                                          |
| ------------------------------------ | --------------------------------------------- |
| 核心不含 MCP（靠扩展）               | 预装 context-mode 等 MCP 扩展为"内置必备包"   |
| 个人助理垂类包稀缺（日历/任务/笔记） | 恰是 EvolveFlow 的差异化——自建为 pi 扩展      |
| Issue #5226 打包坑（asar 路径失效）  | 用 RPC 模式 sidecar 规避，pi 跑独立 Node 进程 |
| 作者集中度（Mario Zechner 主导）     | MIT + 4173 包生态已对冲 bus factor            |

#### Vercel AI SDK 的定位（备选/共存）

不作为底座，但 pi 的 `packages/ai`（模型抽象层）若不够用，
可借鉴 Vercel AI SDK 的 provider 抽象来补 DeepSeek 等模型适配。
两者不互斥。

#### 排除的候选及理由

- **Yuxi(xerrors)**：Python 后端 + 重 Docker 栈 + 多租户渗透式，与"个人本地优先 TS 桌面"
  根本性冲突。砍改成本远超重写。但其知识图谱/AgenticRAG 设计思路值得借鉴。
- **Mastra**：ELv2 协议对"分发给用户本地"的桌面应用有实质风险，且 ADR-0006 的
  F2 fork 改造可能与 ELv2 条款冲突。
- **LangGraph.js / LlamaIndex.ts / codex / hermes / deepagent**：
  分别因 Python绑定/生态小/Rust/偏重/Python 被排除或降为备选。

---

## #3: 框架与 EvolveFlow 现有层的共存方案

Blocked by: #2
Type: Research

### Question

选定框架后，它的数据层/服务层/AI 编排层，和 EvolveFlow 的
storage/domain/capabilities 怎么共存？

- 框架是否强耦合自己的 ORM/DB？能否复用我们的 SQLite？
- 框架的"工具调用"能否桥接到我们的 CapabilityRegistry？
  - 框架的"会话/记忆"和我们的 Dream/ai_sessions 表怎么对齐？
    产出一份"接入点"清单。

### Answer

调研于 2026-06-20，基于读 pi 仓库源码（packages/agent、coding-agent/docs）+ EvolveFlow 本地代码。

#### 核心结论：起步用 SDK 模式 + 桥接扩展，4 个低风险接入点可直接做

pi-agent-core **零数据库依赖**（仅依赖 pi-ai/ignore/typebox/yaml），SessionStorage 是接口抽象（默认 JSONL），这让共存极其干净。

#### 5 个接入点

**接入点1 · 数据层**：pi 无 DB 强耦合。SessionStorage 接口已抽象，默认 JsonlSessionRepo（落 ~/.pi/agent/sessions/\*.jsonl）。**起步姿态：完全隔离**——pi 用自带 JSONL，EvolveFlow 业务库不动，零耦合。中后期可选实现 SqliteSessionStorage（大工作量，按需）。ai_sessions/ai_messages 空壳表本就没在用，不碰。

**接入点2 · 工具桥接**：pi 扩展用 `pi.registerTool({name, description, parameters: Type.Object(...), execute})`。写一个**桥接扩展**，session_start 时遍历 `registry.list()`，每个 capability 注册为 pi tool，execute 内调 `registry.invoke()`。schema 用 `Type.Unsafe(jsonSchema)` 兜底转换。mutating 能力按 ctx.mode 做 gate。**改动量小到中（~150行 + schema 转换测试）**。

**接入点3 · 会话/记忆**：pi 会话是 JSONL 树（version 3，9种entry），比 ai_sessions 表丰富得多——不迁移，pi 用 JSONL。Dream 系统改造成 pi 扩展：监听 tool_result/message_end 写回 action_logs，监听 context/before_agent_start 注入 MemoryProjectionService 的偏好。pi-memctx（Markdown pack）可并存。

**接入点4 · 嵌入方式**：**选 SDK 模式**（非 RPC）。在 sidecar.ts 进程内 `import { createAgentSession }`，省去 RPC 的 U+2028/U+2029 framing 坑和双进程管理。pi-ai 的 DeepSeek provider 替换自研 initAiEngine。**改动量中（替换循环，但能删不少代码）**。

**接入点5 · 扩展预装**：桥接扩展/Dream扩展用本地路径 `pi install ./packages/...`；pi-memctx/context-mode 用 npm 包写入 settings.json packages 数组。打包时随 pi runtime 塞进 Tauri resources。

#### 共存架构（SDK 模式）

```
desktop-tauri(React/Tauri) ──IPC── sidecar.rs ──spawn── sidecar.ts(Node)
                                                         │
                                          ┌──────────────┴──────────────┐
                                          │  pi SDK (进程内嵌入)          │
                                          │  createAgentSession()        │
                                          │   ├ pi-agent-core (无DB)     │
                                          │   ├ pi-ai (DeepSeek provider)│
                                          │   ├ SessionStorage=JSONL     │
                                          │   └ Extensions:             │
                                          │       ├ evolveflow-bridge ──┼─→ CapabilityRegistry.invoke()
                                          │       ├ evolveflow-dream ───┼─→ DreamOrchestrator
                                          │       ├ pi-memctx (npm)     │
                                          │       └ context-mode (npm)  │
                                          └─────────────────────────────┘
                                                         │
                                          evolveflow-capabilities → domain → storage(SQLite)
```

#### 风险分级

| 低风险（MVP可直接做）                       | 需深入设计（按需排期）                      |
| ------------------------------------------- | ------------------------------------------- |
| SDK 模式嵌入 pi                             | SqliteSessionStorage（跨进程SQL查询会话时） |
| CapabilityRegistry→pi.registerTool 桥接扩展 | RPC framing（要进程隔离时）                 |
| pi 用自带 JSONL SessionStorage              | Dream 改造成 pi 扩展（统一记忆层时）        |
| 预装 pi-memctx/context-mode                 | 会话格式迁移决策（做统一历史UI前）          |
| 复用 pi-ai 的 DeepSeek provider             | 扩展打包签名（发版前）                      |
| SessionManager.inMemory() 做集成测试起步    | 作者集中度（已用 F2 fork 对冲）             |

---

## #4: fork-改造的具体操作策略

Blocked by: #2, #3
Type: Discuss

### Question

F2 定了，但具体怎么落地？

- 把框架整库 fork 进 evolveflow 仓库的哪个位置（packages/evolveflow-runtime/ 下？子模块？）
- 砍哪些目录/模块（多用户、云、计费等），预估剥离工作量
- 框架自带的 example/cli 要不要留
  - 我们的 sidecar.ts（JSON-RPC 入口 + Tauri 桥接）怎么和框架的入口对接
    产出一份迁移步骤草案。

### Answer

基于 #3 的 SDK 模式结论，落地策略如下。

#### pi 代码的放置方式：vendor 进 packages/，不是 git submodule

在 `packages/` 下新建两个目录，**把 pi 的源码直接复制进来**（vendor，符合 ADR-0006 F2"fork 一次自己接管"）：

```
packages/
  evolveflow-vendor-pi-agent/    ← 复制自 pi/packages/agent (pi-agent-core)
  evolveflow-vendor-pi-ai/       ← 复制自 pi/packages/ai (pi-ai, provider 适配)
  evolveflow-runtime/            ← 改造：删自研循环，改用 SDK 嵌入
  evolveflow-pi-bridge/          ← 新建：桥接扩展(CapabilityRegistry→pi tool)
  evolveflow-pi-dream/           ← 新建：Dream 作为 pi 扩展（中期）
  evolveflow-pi-presets/         ← 新建：预装配置(pi-memctx/context-mode 的 settings.json)
  evolveflow-capabilities/       ← 不动
  evolveflow-domain/             ← 不动
  evolveflow-storage/            ← 不动
  evolveflow-cli/                ← 不动（CLI 后续改用 pi SDK）
```

**为什么 vendor 而非 submodule**：F2 决定了不追上游，submodule 的"同步上游"语义反而成噪音；vendor 让我们自由改 pi 源码（如修 Issue #5226、加 DeepSeek 适配），且符合"复制改造不重写"。

#### 砍什么 / 留什么

| pi 的部分                           | 处置           | 理由                                    |
| ----------------------------------- | -------------- | --------------------------------------- |
| `packages/agent`（pi-agent-core）   | **留，vendor** | 核心 runtime，SDK 嵌入要用              |
| `packages/ai`（pi-ai）              | **留，vendor** | provider 适配，DeepSeek 要靠它          |
| `packages/coding-agent`（CLI 本体） | **删**         | 编码场景特化，EvolveFlow 不要 CLI agent |
| `packages/tui`（终端 UI）           | **删**         | 桌面应用用 React，不要 TUI              |
| pi 自带 skills（编码向）            | **删**         | EvolveFlow 有自己的 capability 体系     |
| 顶层 docs/scripts/examples          | **删**         | 精简                                    |

#### sidecar.ts 对接方式

现有 sidecar.ts 的**外壳保留**（JSON-RPC 入口、Tauri stdin/stdout 桥接、ALLOWED_CAPABILITIES、reminder/daily-summary 调度器），**内核替换**：

- 删：`initAiEngine`（自研 DeepSeek 循环）、自研 loop.ts 的 runConversation/compactConversation/estimateTokens
- 替换为：`createAgentSession(...)` + 桥接扩展 + pi-ai 的 DeepSeek provider
- 保留并复用：tools.ts 的 capabilityToToolName/toolToCapabilityName 映射逻辑（搬到桥接扩展）、ReminderService/DailySummaryScheduler（继续作为 sidecar 内调度器，不进 pi）
- 保留：handleMessage 的 JSON-RPC 路由结构（可后续用路由表优化，见架构盘点 P1）

#### 迁移步骤草案（分 commit，每步可验证）

| 步  | 内容                                                                 | 验证                                           |
| --- | -------------------------------------------------------------------- | ---------------------------------------------- |
| 1   | vendor pi-agent + pi-ai 源码进 packages/，调通 build                 | `npm run build` 通过，pi 包可 import           |
| 2   | 写 evolveflow-pi-bridge 桥接扩展骨架（registerTool 遍历 registry）   | 单元测试：bridge 把 task.create 注册为 pi tool |
| 3   | sidecar.ts 内用 createAgentSession + bridge 跑通最小对话（DeepSeek） | 手测：AI 页发消息能回，能调 task.create        |
| 4   | 删自研 loop.ts/client.ts（runConversation 等），保留 tools.ts 映射   | 现有 runtime 测试迁移/重写后通过               |
| 5   | 接入会话持久化（pi JSONL 默认）+ 前端读历史                          | AI 页重启后能看到历史会话                      |
| 6   | 预装 pi-memctx（settings.json packages）+ 验证记忆注入               | 对话中能看到记忆上下文                         |
| 7   | Dream 改造为 pi 扩展（中期，单独排期）                               | Dream 随 session 生命周期运行                  |
| 8   | 删 pi 的 coding-agent/tui/docs，清理打包                             | 打包体积可控                                   |

#### 与现有质量门槛的关系

每步都要过 `npm run build && npx vitest run && npm run lint`。步骤 4 的测试迁移是重点——现有 runtime 的 ai.test.ts（14用例）大部分要重写（因为 loop.ts 删了），但 context.ts/tools.ts 的测试可保留。

---

## #5: 插件系统与框架的契合度验证

Blocked by: #2
Type: Prototype

### Question

愿景里的"插件=能力包（新页面+新Agent模式+一组Skill）"，
选定框架是否原生支持这种扩展？如果原生不支持，改造成本多大？
用最小原型验证：写一个 hello-world 插件，看能否（a）注册一个新 Agent 模式、
（b）注册一个新 UI 页面、（c）挂一组 Skill。这验证框架的扩展机制是否够用。

### Answer

基于 #3 对 pi 源码的调研，三分之二的验证已从文档/代码确认，无需再开 prototype session：

| 验证项                | 结论                              | 证据                                                                                       |
| --------------------- | --------------------------------- | ------------------------------------------------------------------------------------------ |
| (a) 注册新 Agent 模式 | ✅ **原生支持**                   | pi 扩展可 `register mode`（动态注册，extensions.md 明示）；核心无硬编码 mode，全靠扩展提供 |
| (c) 挂一组 Skill/Tool | ✅ **原生支持**                   | `pi.registerTool` 是扩展一等公民；桥接扩展正是用这个把 CapabilityRegistry 暴露             |
| (b) 注册新 UI 页面    | 🟡 **部分支持，需自建前端扩展层** | 见下方 #6                                                                                  |

#### (b) 的真相：pi 的 UI 扩展 ≠ EvolveFlow 的"新页面"

pi 有 `extension_ui_request/response` 子协议（扩展可向前端发交互请求），但这只是"扩展 ↔ 现有 UI 的消息通道"，**不等于"动态给 React Router 加一个新页面"**。

EvolveFlow 愿景里的"插件带新页面"（如长程调研插件带一个调研工作台页面），需要 EvolveFlow **自建前端扩展机制**：插件 manifest 声明它要注册的页面 → 前端启动时读 manifest 动态加载组件挂到 Router → pi 的 extension_ui_request 作为"插件运行时 ↔ 其页面"的消息通道。

这是 EvolveFlow 特有的前端工程，pi 帮不上，但也不阻塞——pi 侧的工具/模式扩展已验证 OK，前端扩展层独立做。

#### 结论：pi 扩展机制足够支撑"插件=能力包"愿景，decision-map 收尾

"前端动态页面扩展"是实现期的事，转入新 ticket #6 跟踪，不阻塞框架选型。

---

## #6: EvolveFlow 前端动态页面扩展机制

Blocked by: #4（fork 落地后）
Type: Prototype

### Question

愿景里"插件带新页面"（如长程调研插件带一个 React 工作台页面），需要 EvolveFlow 自建前端扩展层：插件 manifest 声明页面 → 前端动态加载。pi 不提供这层。用原型验证可行性：插件包导出 React 组件 + manifest，前端运行时动态 import 并挂到 Router。

### Answer

（实现期 Prototype，fork 落地后再做。当前记为已知工作项，不阻塞决策。）

---

## 雾区（部分已随 #3/#4 消散）

- ~~自研 runtime 里哪些代码值得抢救性保留~~ → 已答（#4：tools.ts 映射保留、调度器保留、loop/client 删）
- ~~Dream 系统在新框架下怎么重新接入~~ → 已答（#3：改造成 pi 扩展，中期排期，步骤7）
- ~~旧测试如何迁移/重写~~ → 已答（#4：ai.test.ts 大部分重写，context/tools 测试保留）
- 切换期的双跑/灰度策略（是否需要）→ 单人项目，按 #4 的 8 步增量迁移即可，不做双跑
- 版本/发布如何处理（fork 后的版本号、CHANGELOG）→ 待发版前再定，当前不阻塞

---

## Decision Map 状态：✅ 雾散，决策完成

所有 frontier ticket（#1-#5）已解决，#6 转为实现期工作项。
**路径到 finish line 已清晰**：按 #4 的 8 步迁移草案执行。

下一步：进入 `/to-prd`，把 #4 的迁移步骤草案转成可执行 PRD，
落到 `.scratch/agent-framework-replacement/PRD.md`，然后用 `/implement` 执行。
