# Onboarding · EvolveFlow

> 给"未来的自己"和任何新加入的人。30 分钟内理解项目并跑起来。

EvolveFlow 是一个 **AI 原生、本地优先的个人日程/任务助手桌面应用**：
你用自然语言跟 AI 说话，AI 通过工具调用帮你排日程、建任务、设提醒，
数据全在本地 SQLite，所有操作可撤销。

---

## 1. 先读这三份

按顺序读，建立全局认知：

1. **[README.md](README.md)** —— 项目门面：是什么、技术栈、怎么跑。
2. **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** —— 分层架构与数据流（storage → domain → capabilities → runtime → UI）。
3. **[docs/workflow.md](docs/workflow.md)** —— 人和 AI 如何协作（用 `/` 命令驱动，先对齐再执行）。

读完你应该能回答：项目分几层？AI 怎么操作数据？数据存哪？为什么用 sidecar？

---

## 2. 跑起来（5 分钟）

```bash
# 前置：Node.js >= 20，npm >= 10，Rust 工具链（桌面构建用）
npm install          # 装所有 workspace 依赖
npm run build        # 全栈构建（TS 编译 + Vite 打包）
npm run dev -w @evolveflow/cli          # 跑 CLI
npm run dev -w @evolveflow/desktop-tauri # 跑桌面应用（需 Rust）
```

**验证一切正常：**

```bash
npx vitest run       # 全测试应通过（77 个用例）
npm run lint         # 应 0 errors
npm run typecheck --workspaces --if-present
```

---

## 3. 代码地图

| 层     | 包                                 | 职责                                                 |
| ------ | ---------------------------------- | ---------------------------------------------------- |
| 存储   | `packages/evolveflow-storage`      | SQLite、schema 迁移、备份/恢复/导出                  |
| 领域   | `packages/evolveflow-domain`       | Task/Event/Schedule/Reminder/Undo/Summary 等服务     |
| 能力   | `packages/evolveflow-capabilities` | 统一注册表、输入验证、幂等、权限钩子                 |
| 运行时 | `packages/evolveflow-runtime`      | AI sidecar：DeepSeek 集成、工具调用、对话循环、Dream |
| CLI    | `packages/evolveflow-cli`          | 终端客户端                                           |
| 桌面   | `apps/desktop-tauri`               | Tauri v2 + React 前端                                |

**依赖方向（单向，严禁反向）：**

```
storage ← domain ← capabilities ← runtime ← (cli / desktop)
```

---

## 4. 配置 AI（DeepSeek）

应用需要 DeepSeek API Key 才能用 AI 功能：

- **桌面端**：设置页 → AI 配置 → 保存 DeepSeek API Key
- **终端**：环境变量 `EVOLVEFLOW_AI_KEY` 或 `DEEPSEEK_API_KEY`

Provider/Model 固定为 DeepSeek（`deepseek-v4-flash`），见 `packages/evolveflow-runtime/src/ai/deepseek.ts`。

---

## 5. 核心概念（速查）

- **Capability（能力）** —— AI 和 UI 操作数据的统一接口，全部注册在 capabilities 层。每个操作都记 action_log。
- **锁定（Lock）** —— 用户可锁定任务/时间块，AI 不能改动。AI 安全机制。
- **撤销（Undo）** —— 每个变更操作存状态快照，可回滚。
- **排程（Schedule）** —— 加权评分算法分配时间块，尊重锁定项和能量曲线。
- **Dream** —— 从行为提炼洞察的长期记忆系统（半成品）。

> 完整术语表见 `UBIQUITOUS_LANGUAGE.md`（由 `/ubiquitous-language` 生成）。

---

## 6. 改代码前

- **先说意图，再动手**（见 [docs/workflow.md](docs/workflow.md)）。
- 改完每块都跑 `npm run build && npx vitest run && npm run lint`。
- 代码与文档对齐：改了架构/数据流，同步更新 `docs/ARCHITECTURE.md`。
- 重要技术决策写一条 ADR 到 `docs/adr/`。

---

## 7. 下一步

- 想加功能？先 `/grill-me` 拷问想法，再 `/to-prd` 转成需求。
- 要离开一段时间？`/handoff` 留交接文档。
- 项目意图/边界模糊？跑 `/setup-matt-pocock-skills` 建 `CONTEXT.md`。
