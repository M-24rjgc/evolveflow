# Contributing to EvolveFlow

Thank you for considering contributing to EvolveFlow! This document outlines the development workflow, coding standards, and processes we follow.

---

## Table of Contents

1. [Development Environment Setup](#development-environment-setup)
2. [Code Style Guidelines](#code-style-guidelines)
3. [Testing Requirements](#testing-requirements)
4. [Pull Request Process](#pull-request-process)
5. [Commit Conventions](#commit-conventions)
6. [Project Structure](#project-structure)

---

## Development Environment Setup

### Prerequisites

- **Node.js** >= 20.x
- **npm** >= 10.x
- **Git**
- **Rust toolchain** (for Tauri desktop builds) -- [Install Rust](https://www.rust-lang.org/tools/install)

### Initial Setup

```bash
# Clone the repository
git clone https://github.com/M-24rjgc/evolveflow.git
cd evolveflow

# Install all dependencies (workspaces)
npm install

# Build all packages to verify setup
npm run build

# Run tests to verify everything works
npm test
```

### Editor Configuration

We recommend using Visual Studio Code with the following extensions:

- **ESLint** (dbaeumer.vscode-eslint)
- **Prettier** (esbenp.prettier-vscode)
- **TypeScript + JavaScript** (ms-vscode.vscode-typescript-next)

The project includes workspace settings for ESLint and Prettier auto-formatting on save.

---

## Code Style Guidelines

### TypeScript

- **Target**: ES2022
- **Module**: NodeNext
- **Strict mode**: Always enabled
- **Naming conventions**:
  - `PascalCase` for classes, interfaces, types, enums
  - `camelCase` for functions, methods, variables, parameters
  - `UPPER_CASE` for constants
  - `kebab-case` for file names
- **Exports**: Use named exports for all public APIs, default exports only for React components
- **Imports**: Use ES module syntax with `.js` extensions in source files
- **Access modifiers**: Default to `private` for internal methods, `public` for API surface

### Formatting

- **Indentation**: 2 spaces
- **Quotes**: Single quotes for strings
- **Semicolons**: Always
- **Trailing commas**: ES5 style (trailing commas in multiline arrays/objects)
- **Line length**: 120 characters max

Formatting is enforced by Prettier. Run `npm run format:fix` before committing.

### Linting

- ESLint with `@typescript-eslint` rules
- `no-console`: warn (except in `runtime/` where it's allowed)
- `no-unused-vars`: warn (with `_` prefix ignore pattern)
- `eqeqeq`: error (always use `===` / `!==`)
- `curly`: error (always use braces)

Run `npm run lint` before committing to check for issues.

---

## Testing Requirements

### Test Framework

We use **Vitest** as our test runner with the following configuration:

- **Test files**: Located in `tests/` directories at each package level
- **Naming**: `*.test.ts` or `*.spec.ts`
- **Coverage threshold**: 50% minimum across all metrics (lines, branches, functions, statements)

### Writing Tests

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MyService } from '../src/my-service.js';

describe('MyService', () => {
  let service: MyService;

  beforeAll(() => {
    service = new MyService(/* ... */);
  });

  it('should do something', () => {
    const result = service.doSomething();
    expect(result).toBeDefined();
    expect(result).toHaveProperty('id');
  });
});
```

### Running Tests

```bash
# Run all tests
npm test

# Run tests with coverage
npm run test:coverage

# Run tests in watch mode
npm run test:watch

# Run tests for a specific package
npm run test -w @evolveflow/domain
```

### Test Guidelines

1. **Unit tests**: Test services in isolation, mock database dependencies
2. **Integration tests**: Test service interactions with a real SQLite database (use temp directories)
3. **Coverage**: Aim for >50% coverage, 80%+ for critical domain logic
4. **Cleanup**: Always clean up temp databases in `afterAll`/`afterEach`

---

## Pull Request Process

1. **Create a feature branch** from `main`:

   ```bash
   git checkout -b feat/my-feature
   ```

2. **Make your changes** following the code style guidelines.

3. **Write or update tests** for your changes.

4. **Run the full test suite** to ensure nothing is broken:

   ```bash
   npm test
   npm run lint
   npm run typecheck
   ```

5. **Commit your changes** using Conventional Commits (see below).

6. **Push and create a PR**:

   ```bash
   git push origin feat/my-feature
   ```

   Then create a PR on GitHub against the `main` branch.

7. **PR requirements**:
   - Descriptive title and description
   - Reference related issues
   - All CI checks passing
   - At least one reviewer approval

8. **Merge**: Use squash merge to keep history clean.

---

## Commit Conventions

We follow [Conventional Commits](https://www.conventionalcommits.org/) for all commit messages.

### Format

```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

### Types

| Type       | Description                                |
| ---------- | ------------------------------------------ |
| `feat`     | A new feature                              |
| `fix`      | A bug fix                                  |
| `docs`     | Documentation changes                      |
| `style`    | Code formatting, linting (no logic change) |
| `refactor` | Code restructuring (no feature/fix)        |
| `perf`     | Performance improvements                   |
| `test`     | Adding or updating tests                   |
| `chore`    | Build process, dependencies, tooling       |
| `ci`       | CI/CD configuration changes                |

### Examples

```
feat(storage): add backup rotation with configurable max count

fix(domain): handle null due_date in TaskService.defer

docs: add architecture overview to README

test(capabilities): add unit tests for input validation

chore(deps): update better-sqlite3 to v11
```

---

## Project Structure

```
evolveflow/
├── packages/
│   ├── evolveflow-storage/     # Data persistence layer
│   ├── evolveflow-domain/      # Business logic services
│   ├── evolveflow-capabilities/ # Unified API registry
│   ├── evolveflow-cli/         # CLI application
│   └── evolveflow-ui-shared/   # Shared UI components/types
├── apps/
│   └── desktop-tauri/          # Tauri desktop application
├── runtime/                    # AI runtime sidecar
└── tests/                      # Integration tests
```

Each package has its own `tests/` directory and `vitest.config.ts`. The root `vitest.workspace.ts` ties all package configs together.

---

## Questions?

If you have questions or need help, please open a GitHub Discussion or ask in the PR comments.
