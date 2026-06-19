# EvolveFlow 协作工作流

> 这份文档定义"人和 AI（ZCode）如何围绕这个项目长期协作"。
>
> **角色分工**：AI 是**主动引导者**，严格按下方层级顺序推进，每一步主动告知
> "现在做什么、你需要提供什么"；人是决策者，负责回答关键问题。
> 人忘记流程时，AI 兜底引导，不让人掉链子。
>
> 核心原则：**先对齐，再执行**——任何重构/新功能前，先澄清意图。
> 核心原则：**代码与文档对齐**——文档说的必须和代码一致。

---

## 项目当前位置：中段切入

EvolveFlow 不是从零开始。当前状态：

- ✅ 代码能跑（77 测试通过）、刚完成结构重构、有 4 条 ADR
- ✅ 工程技能体系已配置（`docs/agents/`、`.scratch/`、`.zcode/skills-config.json`）
- 🟡 `docs/CONTEXT.md` 是占位，术语表为空
- ❌ "接下来往哪走"方向模糊

因此工作流从**第 0 层（一次性补齐地基）**开始，而非从"想法"开始。

---

## 第 0 层 · 一次性补齐地基（现在做一次）

这一层只做一次，目的是让后续所有 skill 都能正确运转。

### 0.1 修 CONTEXT.md 格式

- **问题**：当前 `docs/CONTEXT.md` 是"产品宪法"（价值主张/边界/成熟度），
  但 `domain-modeling` skill 期望它是**纯术语表**（glossary）。
- **做法**：拆成两层——`docs/CONTEXT.md` 保留产品宪法，
  术语表部分由 0.2 填充进专门的小节或独立文件。
- **引导者**：AI 主动提出拆分方案，人确认。

### 0.2 跑 `/ubiquitous-language` 填术语表

- **目的**：从已有对话（审查/重构/setup 这几轮）提炼领域术语。
- **产出**：术语表（capability、排程、锁定、dream、sidecar、time_effect_type 等），含定义和关系。
- **引导者**：AI 主动启动，扫描对话，产出草稿，人校对。

### 0.3 跑 `/improve-codebase-architecture`（只用报告部分）

- **目的**：盘点刚完成的重构，把现状"地图化"——哪些模块已深、哪些仍有 friction。
- **注意**：本项目刚做完重构，**只取它的"探索 + HTML 报告"部分做现状理解**，
  不进入它默认的 grilling 重构循环。
- **引导者**：AI 主动发起扫描，产出报告，人和 AI 一起看报告定下一步。

### 0.4 修两个冲突点

- **`qa` / `request-refactor-plan` 用 GitHub issue**：与你配的本地 markdown tracker 冲突。
  决策：暂不切换 tracker，这两个 skill 需要时手动把 issue 落到 `.scratch/`。
- **术语源唯一化**：0.2 完成后，术语只认一处（CONTEXT.md 术语表），
  不另建 `UBIQUITOUS_LANGUAGE.md`，避免分裂。

**第 0 层完成后**，项目进入"方向待定、地基扎实"的稳态，进入第 1 层。

---

## 第 1 层 · 定方向（每次回来先做）

每次回到项目，先在这一层确定"这次要推进什么"。

| 情况                               | 用什么              | 说明                     |
| ---------------------------------- | ------------------- | ------------------------ |
| 方向模糊，要拷问"项目该往哪走"     | `/grill-with-docs`  | 拷问 + 边问边补术语/ADR  |
| 一个大决策需要多日/多 session 调研 | `/decision-mapping` | 拆成多张 ticket 逐个推进 |
| 一个具体的小想法                   | `/grill-me`         | 单次拷问，不落盘         |

**引导者**：AI 在每次会话开始时主动询问"这次想推进什么方向"，根据回答分流到对应 skill。

---

## 第 2 层 · 落工作项

想法/方向拷问清楚后，落地成可执行的工作项。

1. **`/to-prd`** —— 把成熟的决策转成 PRD，落到 `.scratch/<feature-slug>/PRD.md`
2. **`/to-issues`** —— 把 PRD 拆成垂直切片 issue，落到 `.scratch/<feature-slug>/issues/NN-*.md`

**引导者**：第 1 层完成后，AI 主动建议"该转 PRD 了"，启动 to-prd。

---

## 第 3 层 · 干活

工作项就绪后，进入实现。

- **`/implement`**（主入口）—— 按 PRD/issues 执行实现
  - 内部调 **`/tdd`**（垂直切片 red-green）
  - 结束调 **`/review`**（双轴复查：Standards + Spec）
  - 最后 commit 到当前分支

**引导者**：第 2 层完成后，AI 主动建议"开始实现"，启动 implement。

---

## 第 4 层 · 收尾

每次工作块结束、要离开一段时间前。

- **`/handoff`** —— 压缩当前上下文成交接文档，交给下次回来的自己

**引导者**：AI 在检测到工作块接近尾声时主动提示"该 handoff 了"。

---

## 事件驱动（随时触发，不按层级）

| 事件                  | skill                                      |
| --------------------- | ------------------------------------------ |
| 遇到硬 bug            | `/diagnosing-bugs`                         |
| git merge/rebase 冲突 | `/resolving-merge-conflicts`               |
| 想找架构摩擦点        | `/improve-codebase-architecture`（完整版） |
| 设计新模块接口        | `/design-an-interface`                     |
| 验证状态机/UI 方向    | `/prototype`                               |

---

## 不适用的 skill（已确认与本项目无关，忽略）

写作/教学/笔记类（8 个）：`teach`、`edit-article`、`obsidian-vault`、
`scaffold-exercises`、`writing-beats`、`writing-fragments`、`writing-shape`、`writing-great-skills`。

需注意的冲突：`qa`、`request-refactor-plan` 硬编码 GitHub issue，
本项目用本地 markdown tracker，这两个 skill 需要时手动改落盘位置。

---

## 质量门槛（每次 commit 前必须满足）

- `npm run build` 全栈构建通过
- `npx vitest run` 全测试通过（当前 77 个）
- `npm run lint` 0 errors
- `npm run typecheck --workspaces --if-present` 通过

---

## 文档维护规则

| 文档                       | 改动时机                                            |
| -------------------------- | --------------------------------------------------- |
| `docs/CONTEXT.md`          | 领域概念/边界/术语变化时（由 domain-modeling 维护） |
| `docs/adr/*.md`            | 做了新的重要技术决策时（domain-modeling 克制地产）  |
| `docs/ARCHITECTURE.md`     | 架构/数据流/分层变化时                              |
| `README.md`                | 对外可见信息变化时                                  |
| `docs/CHANGELOG.md`        | 每次发版                                            |
| `docs/workflow.md`（本文） | 工作流本身调整时                                    |

**铁律**：代码与文档对齐。不一致时，要么改代码要么改文档，不留糊涂账。
