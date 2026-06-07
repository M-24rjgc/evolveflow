# EvolveFlow - 智能日程助手

[![CI](https://github.com/M-24rjgc/evolveflow/actions/workflows/ci.yml/badge.svg)](https://github.com/M-24rjgc/evolveflow/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-blue)](https://www.typescriptlang.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

> AI-powered intelligent scheduling assistant -- intelligently manage tasks, events, and daily schedules with AI-driven planning, reminders, and memory.

---

## Overview

EvolveFlow is an open-source, AI-native personal scheduling assistant. It combines a local-first SQLite storage layer, a domain-driven service layer, an AI runtime, and a Tauri-based desktop UI to provide:

- **Smart Task Management** -- Create, defer, complete, and organize tasks with subtasks, tags, and projects.
- **Intelligent Scheduling** -- Automatic day planning with time-aware block allocation.
- **AI-Powered Assistance** -- Natural language interaction via an AI runtime that can create tasks, query schedules, and adapt to user preferences.
- **Undo & History** -- Every action is logged and reversible.
- **Reminders & Notifications** -- Configurable reminders with snooze and dismiss.
- **Local-First** -- All data stays on your machine with built-in backup and export.
- **Dream System (AI Memory)** -- Persistent insight storage for long-term behavior learning.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     Desktop UI (Tauri)                    │
│              React + Vite + Tauri v2                     │
├─────────────────────────────────────────────────────────┤
│                       AI Runtime                         │
│              Anthropic Claude API Integration             │
│              Tool-based interaction                       │
├─────────────────────────────────────────────────────────┤
│                    CLI Interface                          │
│              Commander-based terminal client              │
├─────────────────────────────────────────────────────────┤
│                   Capabilities Layer                      │
│              Unified registry + permissions                │
│              Idempotency + revision tracking               │
├─────────────────────────────────────────────────────────┤
│                    Domain Layer                           │
│      TaskService  EventService  ScheduleService           │
│      ReminderService  UndoService  SummaryService         │
├─────────────────────────────────────────────────────────┤
│                   Storage Layer                           │
│     SQLite (better-sqlite3)  Backup  Export  Migrations   │
└─────────────────────────────────────────────────────────┘
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for detailed design documentation.

---

## Quick Start

### Prerequisites

- **Node.js** >= 20
- **npm** >= 10
- **Rust toolchain** (for Tauri desktop build) -- see [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)

### Setup

```bash
# Clone the repository
git clone https://github.com/M-24rjgc/evolveflow.git
cd evolveflow

# Install dependencies (all workspaces)
npm install

# Build all packages
npm run build

# Run the CLI
npm run dev -w @evolveflow/cli

# Run the desktop app (requires Rust toolchain)
npm run dev -w @evolveflow/desktop-tauri
```

### Testing

```bash
# Run all tests
npm test

# Run tests with coverage
npm run test:coverage

# Watch mode
npm run test:watch
```

### Linting

```bash
# Check code style
npm run lint

# Auto-fix
npm run lint:fix

# Format code
npm run format:fix
```

---

## Project Structure

```
evolveflow/
├── packages/
│   ├── evolveflow-storage/        # SQLite database, migrations, backup
│   ├── evolveflow-domain/         # Domain services (tasks, events, schedule, etc.)
│   ├── evolveflow-capabilities/   # Capability registry (unified API layer)
│   ├── evolveflow-cli/            # CLI interface (Commander)
│   └── evolveflow-ui-shared/      # Shared UI types and utilities
├── apps/
│   └── desktop-tauri/             # Tauri v2 desktop application (React + Vite)
├── runtime/
│   ├── src/ai/                    # AI integration (Anthropic Claude API)
│   └── src/sidecar.ts             # Sidecar process for AI runtime
├── tests/                         # Integration tests
├── .github/                       # CI/CD workflows and Dependabot config
├── .husky/                        # Pre-commit hooks
├── vitest.config.ts               # Vitest test configuration
├── vitest.workspace.ts            # Vitest workspace configuration
└── .eslintrc.json                 # ESLint configuration
```

---

## Development Guides

- [Architecture Overview](ARCHITECTURE.md) -- Learn about the system design and data flow
- [Contributing Guide](CONTRIBUTING.md) -- How to contribute, coding standards, PR process
- [Changelog](CHANGELOG.md) -- Release history

---

## Key Technologies

| Layer | Technology |
|-------|-----------|
| Database | SQLite via better-sqlite3 |
| Backend | TypeScript, Node.js |
| Desktop | Tauri v2, React, Vite |
| AI | Anthropic Claude API |
| Testing | Vitest, ESLint, Prettier |
| CI/CD | GitHub Actions |

---

## License

[MIT](LICENSE) -- feel free to use, modify, and distribute.

---

## Badges

[![CI Status](https://github.com/M-24rjgc/evolveflow/actions/workflows/ci.yml/badge.svg)](https://github.com/M-24rjgc/evolveflow/actions/workflows/ci.yml)
[![Coverage](https://codecov.io/gh/M-24rjgc/evolveflow/branch/main/graph/badge.svg)](https://codecov.io/gh/M-24rjgc/evolveflow)
