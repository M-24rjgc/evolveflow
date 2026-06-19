# ADR-0007：选用 earendil-works/pi 作为 Agent runtime 底座

- **状态**：已接受
- **日期**：2026-06-20
- **相关**：ADR-0006（F2 fork 改造哲学）、CONTEXT.md "愿景形态"、
  `.scratch/agent-framework-replacement/decision-map.md` #1 #2

## 背景

EvolveFlow 自研 runtime 已暴露根本性问题（会话不持久化、sidecar 上帝进程、
压缩/重试 bug 频发）。ADR-0006 确定了 F2（fork 一次、自己接管、复制改造不重写）
的选型哲学。本 ADR 记录"选哪个框架"这一决策。

经 decision-map #1（候选盘点）+ #2（对照北极星筛选）调研：

- 用户提名的 6 个名字核实：yuxi=查无/记混、OpenClaudeCode=泄露重建CLI、
  codex=Rust成品agent、pi=earendil-works/pi(TS本地优先harness)、
  hermes=偏重、deepagent=Python绑定
- 主流框架对比：Vercel AI SDK(library非harness)、LangGraph.js(Python二等)、
  Mastra(ELv2协议风险)、LlamaIndex.ts(生态小)
- 补充核实 xerrors/Yuxi：Python后端+重Docker+多租户渗透式，栈冲突

## 决策

**选用 `earendil-works/pi`（github.com/earendil-works/pi）作为 EvolveFlow 的
Agent runtime 底座，以 ADR-0006 的 F2 方式（fork 改造，不追上游）接入。**

### 选定理由（关键论据）

1. **哲学同构**：pi 的"最小核心 + 扩展即能力"与 EvolveFlow 的"插件=能力包"
   （CONTEXT 愿景）几乎同一理念。pi 扩展能注册 tool/mode/command/prompt，
   正是 EvolveFlow 想要的"能力包"。
2. **harness 而非 library**：pi 是骨架（agent 运行循环/会话引擎/事件总线完整），
   拿来改；而 Vercel AI SDK 是砖头（要自建 harness），违背"不重写"。
3. **MIT + TS/Node + 本地优先**：三个硬指标全中，无协议/栈/理念冲突。
4. **会话持久化是核心一等公民**：直接补上自研 runtime 最大的缺口
   （ai_sessions 表建了从不写入）。
5. **拿来主义生态**：4173+ 包，pi-memctx（记忆/RAG）、context-mode（MCP+上下文压缩）
   等可直接预装；EvolveFlow 的日程/任务能力作为 pi 扩展开发，可反哺生态。
6. **嵌入桌面**：SDK + RPC 双路径，RPC 模式 sidecar 规避打包坑（Issue #5226）。

### 已知短板及应对

| 短板                                 | 应对                                        |
| ------------------------------------ | ------------------------------------------- |
| 核心不含 MCP（靠扩展）               | 预装 context-mode 等 MCP 扩展为"内置必备包" |
| 个人助理垂类包稀缺（日历/任务/笔记） | EvolveFlow 自建为 pi 扩展（恰是差异化）     |
| Issue #5226 打包坑（asar 路径失效）  | RPC 模式 sidecar 规避                       |
| 作者集中度（Mario Zechner 主导）     | MIT + 海量生态对冲 bus factor               |

## 后果

- **好处**：
  - 获得生产级 Agent harness，不再手写 loop/client/会话/压缩。
  - 继承成熟扩展系统，插件机制不用从零设计。
  - 补上持久化、可观测性等长期缺口。
  - 站在活跃生态上，部分能力可拿来主义。
- **代价 / 风险**：
  - 接入工作量：需把 pi 的 agent/ai 核心包融入现有分层，
    并桥接 CapabilityRegistry（见 decision-map #3 #4）。
  - pi 核心无 MCP/Plan 模式，需管理一组"必备扩展"依赖。
  - 不追上游（ADR-0006），安全补丁需自盯。
- **监控点**：若 pi 核心架构发生破坏性变更而我们已深度 fork，
  或 bus factor 风险显现，应新写 ADR 重新评估。

## 备选方案（及放弃理由）

- **Vercel AI SDK**：library 非 harness，harness 层全要自建，违背"不重写"。降为
  provider 抽象的借鉴对象（补 DeepSeek 等模型适配时参考）。
- **xerrors/Yuxi**：Python 后端 + 重 Docker 栈 + 多租户渗透式，与"个人本地优先 TS 桌面"
  根本性冲突。砍改成本远超重写。其知识图谱/AgenticRAG 设计思路可借鉴。
- **Mastra**：ELv2 协议对分发给用户本地的桌面应用有实质风险，且 F2 fork 可能违约。
- **LangGraph.js / LlamaIndex.ts**：分别因 Python 二等公民 / 生态小 / 偏重排除。
- **继续 100% 自研**：已证明单人无法驾驭 Agent runtime 全部复杂度。
