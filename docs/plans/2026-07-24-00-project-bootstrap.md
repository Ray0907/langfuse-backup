# Project Bootstrap Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement
> this plan task-by-task.

**Goal:** Create a tested, publishable TypeScript CLI skeleton and OCI image
without implementing backup behavior.

**Architecture:** Keep one root npm package with internal modules under `src/`.
Expose one `langfuse-backup` executable and keep provider interfaces private
until multiple implementations prove the abstraction.

**Tech Stack:** Node.js 24, TypeScript, pnpm 11, Commander, Zod, Vitest, tsup,
ESLint, Docker, GitHub Actions.

---

## Prerequisites

- Work in `/Users/ray/Documents/Ray/langfuse-backup`.
- Initialize a new Git repository; do not nest it inside another repository.
- Install Node.js 24 and pnpm 11.
- Read [Architecture](../architecture.md) before implementing.

### Task 1: Initialize the OSS repository

**Files:**

- Create: `.gitignore`
- Create: `.editorconfig`
- Create: `.nvmrc`
- Create: `LICENSE`
- Create: `package.json`
- Create: `pnpm-workspace.yaml`

**Step 1: Confirm the directory is not already a Git repository**

Run: `git rev-parse --show-toplevel`

Expected: FAIL because no repository exists at this path.

**Step 2: Initialize Git**

Run: `git init -b main`

Expected: repository initialized with branch `main`.

**Step 3: Add project metadata**

Set the package name to `langfuse-backup`, license to MIT, Node engine to
`>=24`, package manager to the pinned pnpm 11 version, and the executable to
`dist/cli.js`.

Required scripts:

```json
{
  "build": "tsup",
  "lint": "eslint .",
  "test": "vitest run",
  "test:watch": "vitest",
  "typecheck": "tsc --noEmit",
  "verify": "pnpm lint && pnpm typecheck && pnpm test && pnpm build"
}
```

**Step 4: Install dependencies**

Run: `pnpm install`

Expected: `pnpm-lock.yaml` is created without npm or yarn lockfiles.

**Step 5: Commit**

```bash
git add .editorconfig .gitignore .nvmrc LICENSE package.json pnpm-lock.yaml
git add pnpm-workspace.yaml
git commit -m "chore: bootstrap langfuse backup project"
```

### Task 2: Configure TypeScript, lint, build, and tests

**Files:**

- Create: `tsconfig.json`
- Create: `eslint.config.mjs`
- Create: `tsup.config.ts`
- Create: `vitest.config.ts`
- Create: `src/index.ts`
- Create: `src/cli.ts`
- Test: `test/cli.test.ts`

**Step 1: Write the failing CLI test**

The test executes the CLI with `--help` and asserts:

```text
langfuse-backup
doctor
create
list
inspect
verify
restore
```

Run: `pnpm test test/cli.test.ts`

Expected: FAIL because `src/cli.ts` does not implement the commands.

**Step 2: Implement the minimal CLI**

Create a Commander program with placeholder commands. Every placeholder exits
with a non-zero `NOT_IMPLEMENTED` error except `--help` and `--version`.

Export `createProgram()` from `src/cli.ts` so tests do not spawn a subprocess.
Keep `src/index.ts` limited to parsing `process.argv` and mapping errors to exit
codes.

**Step 3: Run targeted checks**

Run: `pnpm test test/cli.test.ts`

Expected: one test file passes and no test is skipped.

Run: `pnpm typecheck`

Expected: exit code 0 with no TypeScript errors.

**Step 4: Build and inspect the executable**

Run: `pnpm build`

Expected: `dist/cli.js` exists and starts with a Node shebang.

Run: `node dist/cli.js --help`

Expected: all required commands appear.

**Step 5: Commit**

```bash
git add eslint.config.mjs tsconfig.json tsup.config.ts vitest.config.ts
git add src test
git commit -m "feat: add backup CLI skeleton"
```

### Task 3: Add configuration and logging contracts

**Files:**

- Create: `src/config/schema.ts`
- Create: `src/config/loadConfig.ts`
- Create: `src/logging/logger.ts`
- Create: `src/logging/redact.ts`
- Test: `test/config/loadConfig.test.ts`
- Test: `test/logging/redact.test.ts`
- Create: `examples/config.example.yaml`

**Step 1: Write failing schema and redaction tests**

Cover:

- Missing deployment ID.
- Unsupported consistency mode.
- Secret values accepted only through environment-variable or file references.
- Passwords, URLs with credentials, HMAC secrets, and database URLs are redacted.

Run: `pnpm test test/config test/logging`

Expected: FAIL because the modules do not exist.

**Step 2: Implement minimal contracts**

Support YAML keys documented in `docs/architecture.md`. Do not add Kubernetes,
Azure, or managed database fields. Return a frozen, typed configuration object.

All adapters must receive the logger from the orchestrator; no module creates a
second global logger.

**Step 3: Run targeted tests**

Run: `pnpm test test/config test/logging`

Expected: all config and logging tests pass.

**Step 4: Run repository verification**

Run: `pnpm verify`

Expected: lint, typecheck, tests, and build all exit 0.

**Step 5: Commit**

```bash
git add src/config src/logging test/config test/logging examples
git commit -m "feat: validate config and redact secrets"
```

### Task 4: Build the OCI image

**Files:**

- Create: `Dockerfile`
- Create: `.dockerignore`
- Create: `test/container/smoke.sh`

**Step 1: Write the smoke test**

The script checks:

```bash
langfuse-backup --help
pg_dump --version
pg_restore --version
```

**Step 2: Build the image**

Use a multi-stage build. The runtime image contains Node.js 24, the compiled
CLI, production dependencies, CA certificates, and PostgreSQL 17 client tools.
Run as a non-root user.

Run: `docker build -t langfuse-backup:test .`

Expected: image builds without secrets or development dependencies.

**Step 3: Run the smoke test**

Run: `docker run --rm langfuse-backup:test --help`

Expected: exit code 0 and the CLI help is printed.

**Step 4: Commit**

```bash
git add Dockerfile .dockerignore test/container/smoke.sh
git commit -m "build: add backup CLI container"
```

### Task 5: Add continuous integration

**Files:**

- Create: `.github/workflows/ci.yml`
- Create: `.github/dependabot.yml`
- Modify: `README.md`

**Step 1: Configure CI**

Run these jobs on pull requests and pushes to `main`:

- Install with frozen lockfile.
- `pnpm lint`.
- `pnpm typecheck`.
- `pnpm test`.
- `pnpm build`.
- Docker image build and smoke test.

Pin action versions to full commit SHAs.

**Step 2: Validate locally**

Run: `pnpm verify`

Expected: all four local gates pass.

Run: `docker build -t langfuse-backup:test .`

Expected: image builds successfully.

**Step 3: Commit**

```bash
git add .github README.md
git commit -m "ci: verify CLI and container"
```

## Exit Criteria

- `pnpm verify` passes with at least one real test.
- The OCI image runs as non-root and contains PostgreSQL client tools.
- `node dist/cli.js --help` lists every planned command.
- No backup command claims to work yet.
- CI repeats the same lint, typecheck, test, build, and container checks.

