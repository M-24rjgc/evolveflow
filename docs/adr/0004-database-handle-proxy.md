# ADR-0004：用 Proxy 句柄解决数据库连接 reopen 后句柄失效

- **状态**：已接受
- **日期**：2026-06-19
- **相关代码**：`packages/evolveflow-storage/src/database.ts`、`backup.ts`
- **前置**：由一次 bug 修复驱动（见会话历史）。

## 背景

`BackupService.restoreFrom()` 需要替换磁盘上的数据库文件：先关闭当前连接，
覆盖文件，再重新打开。但所有 domain 服务在构造时通过 `db.getDb()` 捕获了底层
`better-sqlite3` 句柄的引用。`close()` 之后这些引用全部失效，后续任何查询
都抛 `"The database connection is not open"`——备份恢复后整个应用必崩。

better-sqlite3 不支持在同一对象上 reopen（`close()` 后对象不可复活）。

## 决策

**让 `EvolveFlowDatabase.getDb()` 返回一个 Proxy 句柄，转发所有属性访问到
当前活动的底层连接；新增 `reopen()` 方法替换内部连接，Proxy 引用保持不变。**

落地方式：

- `createHandleProxy()` 用 `new Proxy({} as Database.Database, { get ... })`，
  get trap 读取当前的 `this.db`，函数类型自动 `bind`。
- domain 服务仍只调一次 `db.getDb()` 捕获句柄，但捕获到的是 Proxy，
  reopen 后自动指向新连接。
- `BackupService.restoreFrom()` 改用 `this.db.reopen()` 而非 `new EvolveFlowDatabase()`。

## 后果

- **好处**：
  - 一次性解决所有持有句柄者的失效问题，无需改每个 domain 服务。
  - reopen 语义清晰，可被任何需要重建连接的场景复用。
  - 有回归测试覆盖（`database.test.ts` 的 reopen 和 backup restore 用例）。
- **代价 / 风险**：
  - Proxy 有微小性能开销（每次属性访问多一层转发）；对 better-sqlite3 的
    高频查询场景影响可忽略。
  - Proxy 的类型断言（`{} as Database.Database`）略损类型安全；
    所有真实方法仍在底层对象上，运行时无碍。
- **监控点**：未来若引入更复杂的 DB 操作模式（连接池、读写分离），
  需重新评估 Proxy 句柄是否仍合适。

## 备选方案

- **让每个 domain 服务持有 `EvolveFlowDatabase` 引用而非底层句柄，每次操作 `db.getDb()`**：
  改动面大（每个服务每个方法），且 better-sqlite3 同步 API 下频繁 getDb 无谓开销。
- **restore 后通过事件通知所有服务刷新句柄**：
  引入全局可变状态和事件总线，复杂且易漏。
- **不 close，直接覆盖文件**：SQLite WAL 下文件锁/数据一致性不可靠，放弃。
