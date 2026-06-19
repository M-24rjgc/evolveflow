# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

> 决策于 2026-06-19（`/setup-matt-pocock-skills`）。Single-context 布局。
> 注意：本项目把文档集中在 `docs/`，因此 CONTEXT.md 位于 `docs/CONTEXT.md`（非仓库根），
> ADR 位于 `docs/adr/`。下方"读这些"已据此调整。

## Before exploring, read these

- **`docs/CONTEXT.md`** —— 本项目的领域语言、意图、边界（single-context，全仓一份）。
- **`docs/adr/`** —— 读与你即将工作的区域相关的 ADR。编号递增，当前已有 0001–0004。

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `domain-modeling` skill (reached via `grill-with-docs` and `improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

Single-context repo（本项目实际布局，文档集中于 `docs/`）：

```
/
├── docs/
│   ├── CONTEXT.md          ← 领域语言 + 项目意图
│   ├── adr/
│   │   ├── 0001-record-architecture-decisions.md
│   │   ├── 0002-deepseek-over-claude.md
│   │   ├── 0003-sidecar-stdio-jsonrpc.md
│   │   └── 0004-database-handle-proxy.md
│   ├── ARCHITECTURE.md     ← 分层架构与数据流
│   └── workflow.md         ← 人机协作工作流
└── packages/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `docs/CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `domain-modeling` / `/ubiquitous-language`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0002 (deepseek-over-claude) — but worth reopening because…_
