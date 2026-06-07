# EvolveFlow Architecture

## Layered Architecture

EvolveFlow follows a strict layered architecture where each layer depends only on the layer directly below it. This enforces separation of concerns and testability.

```
┌──────────────────────────────────────────────────────────────┐
│                        UI Layer                              │
│  Tauri Desktop (React)     CLI (Commander)                   │
├──────────────────────────────────────────────────────────────┤
│                      AI Runtime Layer                        │
│  Claude API Client      Tool Definitions      Loop Engine    │
│  Context Management     Session Tracking                     │
├──────────────────────────────────────────────────────────────┤
│                    Capabilities Layer                        │
│  Capability Registry     Permission Checks                   │
│  Input Validation        Idempotency                         │
│  Revision Tracking       Error Handling                      │
├──────────────────────────────────────────────────────────────┤
│                     Domain Layer                             │
│  TaskService     EventService     ScheduleService             │
│  ReminderService UndoService     SummaryService              │
│  ActionLogService PreferenceService MemoryProjectionService   │
├──────────────────────────────────────────────────────────────┤
│                    Storage Layer                             │
│  EvolveFlowDatabase     BackupService     ExportService      │
│  ClearService          Migrations        Indexes             │
└──────────────────────────────────────────────────────────────┘
```

### Layer Responsibilities

#### 1. Storage Layer (`packages/evolveflow-storage`)
- SQLite database management with automatic schema migrations
- WAL mode for performance, foreign keys for integrity
- Backup and restore with integrity verification
- Export functionality (JSON, Markdown)
- Clear/reset operations
- Revision counter for optimistic concurrency

#### 2. Domain Layer (`packages/evolveflow-domain`)
- **TaskService**: CRUD for tasks, subtasks, locking, completion, deferral
- **EventService**: CRUD for calendar events
- **ScheduleService**: Intelligent day planning with time-aware block allocation
- **ReminderService**: Reminder creation, snoozing, dismissal, polling
- **ActionLogService**: Immutable action audit trail
- **UndoService**: Action revert via state snapshots
- **SummaryService**: Daily summary generation
- **PreferenceService**: Key-value preference storage
- **MemoryProjectionService**: AI insight projection from stored patterns

#### 3. Capabilities Layer (`packages/evolveflow-capabilities`)
- Unified capability registry exposed to AI and UI
- Input validation with required field checking
- Idempotency key support for safe replay
- Revision tracking for change detection
- Permission/actor-based filtering

#### 4. AI Runtime (`runtime/src/ai/`)
- **client.ts**: Anthropic Claude API client wrapper
- **tools.ts**: Tool definitions exposed to Claude
- **loop.ts**: Main interaction loop (user request -> tool call -> response)
- **context.ts**: Context building and management
- **types.ts**: Shared AI types

#### 5. UI Layer (`apps/desktop-tauri/`)
- React + Vite frontend with Tauri v2 backend
- AI chat page for natural language interaction
- Settings page for configuration
- Sidecar process management for AI runtime

---

## Data Flow

### Task Creation Flow (via AI)

```
User Input
    │
    ▼
AI Runtime (loop.ts)
    │
    ▼
Claude API (client.ts) ──► Tool Call: task.create
    │
    ▼
Capabilities Registry (capabilities.ts)
    │  │  │
    │  │  ├─ Validate input
    │  │  ├─ Check idempotency
    │  │  └─ Record action log
    │
    ▼
TaskService (domain)
    │
    ▼
EvolveFlowDatabase (storage)
    │
    ▼
Response ──► User
```

### Day Planning Flow

```
User Request: "Plan my day"
    │
    ▼
ScheduleService.planDay(date)
    │
    ├─ Fetch pending tasks from database
    ├─ Fetch events from database
    ├─ Allocate time blocks (respecting locked items)
    │
    ▼
Return schedule_blocks[]
    │
    ▼
Display to User (CLI or UI)
```

### Undo Flow

```
User Action: Undo last action
    │
    ▼
UndoService.revertAction(actionLogId)
    │
    ├─ Read stateBefore from action log
    ├─ Apply inverse operation
    ├─ Mark undo group as reverted
    │
    ▼
Database state restored
```

---

## Key Design Decisions

### Why SQLite + better-sqlite3?
- **Local-first**: No server dependency, data stays on user's machine
- **Synchronous API**: simpler code, no async overhead for local operations
- **WAL mode**: concurrent reads without blocking
- **Migration system**: versioned schema evolution with transactional migrations

### Why Capability Registry?
- **Unified interface**: AI and UI use the same API for all operations
- **Security**: Centralized permission and validation checks
- **Auditability**: Every action is logged with actor, origin, and state snapshots
- **Idempotency**: Safe retry with idempotency keys prevents duplicate operations
- **Revision tracking**: Detects concurrent modifications

### Why Undo Service?
- **User confidence**: Every action is reversible
- **State snapshots**: store state before/after for reliable rollback
- **Action grouping**: related actions can be undone together

### Why Locking?
- **AI safety**: Prevent AI from modifying items the user has locked
- **Schedule stability**: Locked time blocks are not auto-rescheduled

---

## AI Integration Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    AI Runtime (sidecar)                    │
│                                                          │
│  ┌─────────────┐    ┌──────────────┐    ┌─────────────┐  │
│  │  Loop Engine │───►│ Claude API   │◄───│  Tool Defs  │  │
│  │  (loop.ts)   │    │ (client.ts)  │    │ (tools.ts)  │  │
│  └──────┬──────┘    └──────┬───────┘    └─────────────┘  │
│         │                  │                              │
│         ▼                  ▼                              │
│  ┌────────────────────────────────────────────────┐      │
│  │         Capability Registry (STDIO)             │      │
│  └────────────────────────────────────────────────┘      │
│                                                          │
└──────────────────────────────────────────────────────────┘
         │
         ▼ (IPC via sidecar)
┌──────────────────────────────────────────────────────────┐
│               Tauri Desktop App                           │
│  ┌─────────────┐    ┌──────────────┐                     │
│  │  AI Page    │    │  Sidecar     │                     │
│  │ (React)     │───►│  (Tauri)     │                     │
│  └─────────────┘    └──────────────┘                     │
└──────────────────────────────────────────────────────────┘
```

The AI runtime runs as a sidecar process spawned by Tauri. Communication happens via stdin/stdout JSON-RPC. The sidecar:
1. Receives a user message from the UI
2. Builds context (preferences, recent actions, current schedule)
3. Sends a request to Claude API with tool definitions
4. Handles tool call responses by invoking capability registry methods
5. Returns the response to the UI

---

## Dream System Design

The Dream System is EvolveFlow's long-term memory and insight engine. It stores patterns discovered from user behavior and provides actionable intelligence.

```
┌─────────────────────────────────────────────────────────────┐
│                    Dream System                              │
│                                                             │
│  ┌──────────────────┐    ┌──────────────────────────────┐   │
│  │ Dream Insights   │    │ Memory Projection Service    │   │
│  │ - Categories     │    │ - Pattern-based projections  │   │
│  │ - Confidence     │    │ - Preference learning        │   │
│  │ - Expiry         │    │ - Insight generation         │   │
│  └──────────────────┘    └──────────────────────────────┘   │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ Storage: dream_insights table (SQLite)               │   │
│  │ - dream_run_id, category, insight_text, confidence,  │   │
│  │   supporting_data, expires_at                        │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

---

## Security Model

### Access Control
- **Actors**: `user`, `ai`, `system` -- each action is tagged with its origin
- **Locking**: Users can lock individual tasks and schedule blocks to prevent AI modification
- **Capability Whitelist**: Only registered capabilities can be invoked

### Data Safety
- **Backup rotation**: Automatic cleanup of old backups (configurable count)
- **Restore safety**: Creates a restore-point before any restore operation
- **Integrity verification**: SHA-256 hash + SQLite PRAGMA integrity_check on backups
- **Idempotency**: Prevents duplicate mutation from retried requests

### AI Safety
- **Tool scope**: AI can only invoke capabilities exposed through the registry
- **Locked items**: AI cannot modify locked tasks or schedule blocks
- **Action log**: All AI actions are logged with complete state snapshots for audit
- **Undo**: All AI mutations can be reverted via the undo service

---

## Performance Considerations

- **SQLite WAL mode**: Enables concurrent reads while writing
- **Indexes**: All query patterns are indexed (tasks by status/due_date, events by start/end, etc.)
- **Cache settings**: SQLite cache sized at 64MB for hot data
- **Reminder polling**: Efficient polling with indexed trigger_at column
- **Backup rotation**: Configurable max backups to prevent disk space issues
