# Changelog

All notable changes to EvolveFlow will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.0.0] - 2025-03-25

### Added

- **Storage Layer**
  - SQLite database with automatic schema migrations (v1, v2)
  - WAL mode for concurrent read/write performance
  - Backup service with SHA-256 integrity verification and rotation
  - Export service (JSON and Markdown format)
  - Clear/reset service for database state

- **Domain Layer**
  - `TaskService`: Full CRUD with subtasks, tags, locking, completion, deferral
  - `EventService`: Calendar event management
  - `ScheduleService`: Intelligent day planning with time-aware scheduling
  - `ReminderService`: Reminder creation, snoozing, dismissal, and polling
  - `ActionLogService`: Immutable audit trail for all actions
  - `UndoService`: Action revert with state snapshot restoration
  - `SummaryService`: Daily task/event summary generation
  - `PreferenceService`: Key-value preference storage
  - `MemoryProjectionService`: Long-term pattern learning and insight projection

- **Capabilities Layer**
  - Unified capability registry with input validation
  - Idempotency key support for safe retry
  - Revision tracking for change detection
  - 18 registered capabilities covering all domain operations

- **AI Runtime**
  - Anthropic Claude API integration with tool definitions
  - Interactive AI loop (user -> tool call -> response)
  - Context building with preferences and schedule data
  - Sidecar process management via Tauri

- **Desktop Application (Tauri v2)**
  - React + Vite frontend
  - AI chat page for natural language interaction
  - Settings page with configuration options
  - Sidecar integration for AI runtime
  - System tray notifications
  - Auto-start support

- **CLI Application**
  - Commander-based command-line interface
  - Task management commands
  - Schedule viewing commands
  - AI interaction commands

- **Infrastructure**
  - TypeScript monorepo with npm workspaces
  - Type-safe service-to-service dependencies
  - Comprehensive error handling throughout
  - Database transactions for mutation safety
