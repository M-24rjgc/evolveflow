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

（待 research session 解决）

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

（待 discuss session 解决）

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

（待 research session 解决）

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

（待 discuss session 解决）

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

（待 prototype session 解决）

---

## 雾区（暂不展开，待 frontier 推进后浮现）

- 自研 runtime 里哪些代码值得抢救性保留（除已列的"特色"外）
- 旧测试如何迁移/重写
- Dream 系统在新框架下怎么重新接入
- 切换期的双跑/灰度策略（是否需要）
- 版本/发布如何处理（fork 后的版本号、CHANGELOG）
