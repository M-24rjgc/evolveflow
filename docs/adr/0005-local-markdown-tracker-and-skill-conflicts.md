# ADR-0005：本地 markdown issue tracker 与两个 skill 的冲突处理

- **状态**：已接受
- **日期**：2026-06-19
- **相关代码**：`docs/agents/issue-tracker.md`、`.zcode/skills-config.json`、`docs/workflow.md`

## 背景

在 `/setup-matt-pocock-skills` 中，我们为这个单人长期迭代项目选择了 **local markdown** issue tracker
（工作项落在 `.scratch/<feature>/`）。但 Matt Pocock 的两个 skill 硬编码使用 GitHub Issues：

- **`qa`**：用 `gh issue create` 从口语 bug 报告创建 GitHub issue
- **`request-refactor-plan`**：把 refactor plan 作为 GitHub issue 发布

如果直接跑这两个 skill，会在本地 markdown tracker 之外另开一个 issue 源，
导致工作项分散在两处，违背"单一 issue 源"原则。

## 决策

**不切换 tracker（保持 local markdown），对两个冲突 skill 做手动适配。**

### 处理方式

1. **`qa`**：遇到要报 bug 时，**不跑 `qa`**，改用本地流程——
   在 `.scratch/<feature>/issues/` 下手写 issue 文件，或直接走 `/diagnosing-bugs`。
2. **`request-refactor-plan`**：需要规划重构时，**不跑它的"建 issue"那步**，
   把产出的 plan 手动写到 `.scratch/<feature>/PRD.md` 或 issue 文件。
3. **术语源唯一化**：术语表只认 `docs/CONTEXT.md` 的"领域术语"小节，
   **不另建 `UBIQUITOUS_LANGUAGE.md`**（`/ubiquitous-language` skill 的默认产物），
   避免 glossary 分裂成两处。

## 后果

- **好处**：
  - 工作项统一在 `.scratch/`，单人项目无需维护 GitHub issue 仪式。
  - 术语单一来源，`domain-modeling` 的"challenge against glossary"机制能正常工作。
- **代价 / 风险**：
  - `qa` 和 `request-refactor-plan` 失去自动化建 issue 的便利，需手动落盘。
  - 若未来转为多人协作、切回 GitHub Issues，需重跑 `/setup-matt-pocock-skills` 并废弃本决策（新写一条 ADR 取代）。

## 备选方案

- **切回 GitHub Issues**：放弃 local markdown。但单人项目为此要管 GitHub issue 生命周期，得不偿失。
- **给两个 skill 打补丁改成本地落盘**：skill 是外部依赖（来自 mattpocock/skills），
  改它们等于 fork，维护成本高。等真有高频需求再说。
