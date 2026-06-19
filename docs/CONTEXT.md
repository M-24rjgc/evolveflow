# EvolveFlow · 项目语境（CONTEXT）

> 这个文件分两部分：
>
> 1. **产品宪法**（下方）——项目是什么、为谁做、做什么不做什么。所有决策的准绳。
> 2. **领域术语表**（文末 `## 领域术语`）——项目使用的核心词汇及其精确定义。
>    这部分由 `domain-modeling` skill 维护，其他 skill 在输出时会引用这里的词汇，
>    遇到与术语表冲突的用词会主动打断质疑。
>
> **产品宪法部分**由人维护；**领域术语部分**由 `/ubiquitous-language` 和
> `/grill-with-docs` 在对话中增量填充。

---

## 一句话定义

EvolveFlow 是一个 **AI 原生、本地优先的个人日程/任务助手桌面应用**。

## 意图与价值主张

- **本地优先**：数据全在用户机器（SQLite），不依赖云服务，可备份导出。
- **AI 驱动**：用自然语言交互，AI 通过工具调用操作数据，而非用户手动填表。
- **可审计可撤销**：每个操作记录 action_log 带状态快照，随时可 undo。
- **AI 安全**：锁定机制让 AI 改不了用户标记的重要项；工具白名单。

## 目标用户

（待明确）——初步设想是"想要 AI 帮忙规划但不想把数据交给云端的个人用户"。
（将在第 1 层 `/grill-with-docs` 拷问后细化。）

## 核心场景

打开应用 → 自然语言告诉 AI 今天的情况 → AI 用加权评分算法排好时间块
（尊重锁定项、避开事件、匹配能量曲线）→ 用户确认/锁定 → 全程可撤销。

## 明确不做（边界）

- **不做云同步**：本地优先是核心，不提供云端账号/同步。
- **不做多用户协作**：个人工具，非团队/家庭共享日历。
- **不做移动端**（当前）：专注桌面。
- **不做通用聊天机器人**：AI 的职责是操作日程数据，工具范围受 capability 白名单约束。

## 当前成熟度（截至 2026-06-19）

- ✅ 能跑：全栈构建、77 测试通过、前端体验打磨到位。
- 🟡 半成品：Dream 系统（AI 记忆）、AI 会话持久化、JSON/Markdown 导出。
- ❌ 未做：真正的乐观并发、约束求解排程（当前是加权评分）。

## 待补充（产品宪法层）

- [ ] 目标用户画像细化（由第 1 层 `/grill-with-docs` 推导）
- [ ] 成功指标：怎样算"真正有用"而非 demo？

---

## 领域术语

> 这部分是项目的 **ubiquitous language（统一语言）**。
> 当任何 skill 或对话中提到这些词时，以此处定义为准。
> 用词与下表冲突时，`domain-modeling` 会打断质疑。
>
> 由 `/ubiquitous-language` 从对话提炼，增量维护。

### 任务域（Task）

| 术语                             | 定义                                                                                | 应避免的别名    |
| -------------------------------- | ----------------------------------------------------------------------------------- | --------------- |
| **Task（任务）**                 | 用户要完成的一件事，有标题、时长、截止日期、状态                                    | todo、item      |
| **Subtask（子任务）**            | 隶属于父任务的子项，通过 parent_task_id 关联                                        | child task      |
| **time_effect_type（时效类型）** | 任务的时间属性，三值：continuous（连续）/ deadline（截止）/ event_bound（绑定事件） | task type       |
| **Lock（锁定）**                 | 用户标记任务不可被 AI 改动的保护状态                                                | freeze、protect |

### 日历域（Calendar）

| 术语                         | 定义                                                                                  | 应避免的别名          |
| ---------------------------- | ------------------------------------------------------------------------------------- | --------------------- |
| **Event（事件）**            | 有固定起止时间的日历项（如会议）                                                      | appointment           |
| **Schedule Block（时间块）** | 排程算法分配的时段，可绑定任务或事件                                                  | slot、time slot       |
| **排程（Scheduling）**       | 把任务分配到时间块的整个子系统（含 `ScheduleService`）；具体方法用 `planDay` 等专有名 | planning、arrangement |

### 能力与操作域（Capability & Operations）

| 术语                       | 定义                                                                             | 应避免的别名              |
| -------------------------- | -------------------------------------------------------------------------------- | ------------------------- |
| **Capability（能力）**     | AI 和 UI 操作数据的统一接口，注册在 capabilities 层，每个变更操作都记 action_log | action、command、function |
| **Action Log（操作日志）** | 每个变更操作的不可变审计记录，含 actor/origin/状态快照                           | history、audit trail      |
| **Undo（撤销）**           | 通过 action_log 的 stateBefore 快照回滚一次变更的操作                            | revert、rollback          |
| **Idempotency（幂等性）**  | 同一 idempotency_key 的重复调用只执行一次的机制                                  | dedup                     |

### AI 运行时域（AI Runtime）

| 术语                            | 定义                                                                                          | 应避免的别名               |
| ------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------- |
| **Sidecar**                     | 由 Tauri spawn 的独立 Node.js 进程，承载 AI 运行时，通过 STDIO JSON-RPC 通信                  | subprocess、worker         |
| **Agent Mode（代理模式）**      | AI 的四种工作模式：chat（仅对话）/ plan（只读不改）/ auto（需批准）/ yolo（全自动）           | -                          |
| **Tool Use（工具调用）**        | AI 模型请求执行某个 capability 的行为，每次有唯一 tool_use_id                                 | function call              |
| **Dream 洞察（Dream insight）** | Dream 系统从用户行为提炼出的长期记忆洞察（半成品）                                            | memory、insight            |
| **会话（Session）**             | 当前内存中的 AI 对话状态（消息历史 + token 统计），进程重启即丢；未来若引入持久化对话另立术语 | conversation、chat history |

### 关系（Relationships）

- 一个 **Task** 可有多个 **Subtask**（通过 parent_task_id）
- 一个 **Event** 可通过 bound_task_id 绑定一个 **Task**（对应 time_effect_type = event_bound）
- 一次 **Tool Use** 触发一个 **Capability**；成功的变更会写一条 **Action Log**；**Action Log** 可被 **Undo** 回滚
- **Capability** 支持 **Idempotency**，AI 发起的变更用 tool_use_id 作幂等键

### 待明确的歧义（Flagged）

- **"会话（Session）"——持久化是未完成功能，不是设计选择。** storage 层已建 `ai_sessions`/`ai_messages` 两张表（含索引、外键），但 runtime 从未向其写入；runtime 的会话状态只存内存 `Map`，进程重启即丢。前端用 localStorage 存了一份显示用副本（最多 100 条），但那是绕过 DB 的兜底，sidecar 的会话状态（token 计数、压缩上下文）重启后全失。`memory.clear_ai_history` 和 `ClearService` 对这两张表只有 `DELETE`、没有 `INSERT`，等于删空表。**"AI 会话持久化"是第 1 层待拷问的优先方向。**
- **"乐观并发"** 在 ARCHITECTURE 里宣称但代码是全局 revision 计数器（非行级锁）。术语先不收录，待第 1 层决定要不要做真正的乐观并发后再定。
