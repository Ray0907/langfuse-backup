# Backup Foundation Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement
> this plan task-by-task.

**Goal:** Create verifiable PostgreSQL and ClickHouse backups in GCS and commit
them with a versioned recovery-point manifest.

**Architecture:** Drive backup creation through an explicit state machine.
Adapters return typed receipts, while the orchestrator owns locking, manifest
commit, retries, and failure cleanup.

**Tech Stack:** TypeScript, Zod, PostgreSQL 17 client, ClickHouse HTTP client,
Google Cloud Storage SDK, Vitest, Docker Compose.

---

## Dependency

Complete
[Project Bootstrap](2026-07-24-00-project-bootstrap.md) before this plan.

### Task 1: Define manifest and receipt schemas

**Files:**

- Create: `src/manifest/schema.ts`
- Create: `src/manifest/serializeManifest.ts`
- Create: `src/manifest/readManifest.ts`
- Test: `test/manifest/schema.test.ts`
- Test: `test/manifest/fixtures/v1-valid.json`

**Step 1: Write failing compatibility tests**

Cover:

- Valid schema version 1.
- Missing PostgreSQL, ClickHouse, or blob receipt.
- Secret values rejected anywhere in serialized output.
- Unknown additive fields accepted.
- Unsupported major schema version rejected.
- Canonical serialization produces stable SHA-256.

Run: `pnpm test test/manifest`

Expected: FAIL because manifest modules do not exist.

**Step 2: Implement the schema**

Use the fields defined in [Architecture](../architecture.md). Component receipts
include provider IDs, timestamps, sizes, checksums, tool versions, and
verification evidence.

**Step 3: Verify**

Run: `pnpm test test/manifest`

Expected: all manifest tests pass.

**Step 4: Commit**

```bash
git add src/manifest test/manifest
git commit -m "feat: define recovery point manifest"
```

### Task 2: Implement destination locking and staging

**Files:**

- Create: `src/destination/types.ts`
- Create: `src/destination/gcsDestination.ts`
- Create: `src/orchestration/backupLock.ts`
- Create: `src/orchestration/backupState.ts`
- Test: `test/destination/gcsDestination.test.ts`
- Test: `test/orchestration/backupLock.test.ts`
- Test: `test/orchestration/backupState.test.ts`

**Step 1: Write failing state and lock tests**

Assert:

- Only one lock can exist per deployment.
- Conditional object creation prevents races.
- Expired locks require an explicit takeover flag.
- Invalid state transitions fail.
- `manifest.json` cannot be written before all component receipts verify.

Run: `pnpm test test/destination test/orchestration`

Expected: FAIL because the implementations do not exist.

**Step 2: Implement the minimal GCS destination**

Support:

- Conditional lock creation.
- Staging object upload and metadata lookup.
- Final manifest upload.
- Listing committed manifests.

Do not add pruning or another destination provider.

**Step 3: Verify**

Run: `pnpm test test/destination test/orchestration`

Expected: all destination and state tests pass.

**Step 4: Commit**

```bash
git add src/destination src/orchestration test/destination test/orchestration
git commit -m "feat: add GCS destination and backup lock"
```

### Task 3: Implement PostgreSQL backup

**Files:**

- Create: `src/adapters/postgres/postgresBackup.ts`
- Create: `src/adapters/postgres/postgresDoctor.ts`
- Create: `src/process/runProcess.ts`
- Test: `test/adapters/postgres/postgresBackup.test.ts`
- Test: `test/process/runProcess.test.ts`
- Integration: `test/integration/postgresBackup.test.ts`

**Step 1: Write the failing process tests**

Cover exit-code preservation, stderr capture, cancellation, timeout, and
redaction. Ensure command arguments containing credentials never appear in logs.

Run: `pnpm test test/process test/adapters/postgres`

Expected: FAIL because no process runner or adapter exists.

**Step 2: Implement `pg_dump` creation**

Run custom-format dumps to a private temporary directory. Hash the closed file,
upload it to staging, verify remote size and checksum, and then delete the local
file.

Never stream a dump directly into the final object in the MVP.

**Step 3: Run the PostgreSQL integration test**

Run: `pnpm test test/integration/postgresBackup.test.ts`

Expected: a seeded row is present after restoring the produced dump into a
second empty PostgreSQL database.

**Step 4: Commit**

```bash
git add src/adapters/postgres src/process test/adapters/postgres
git add test/process test/integration/postgresBackup.test.ts
git commit -m "feat: back up PostgreSQL to GCS"
```

### Task 4: Implement ClickHouse backup

**Files:**

- Create: `src/adapters/clickhouse/clickhouseBackup.ts`
- Create: `src/adapters/clickhouse/clickhouseDoctor.ts`
- Create: `src/adapters/clickhouse/queryBackupStatus.ts`
- Test: `test/adapters/clickhouse/clickhouseBackup.test.ts`
- Integration: `test/integration/clickhouseBackup.test.ts`

**Step 1: Write failing adapter tests**

Cover:

- Unique backup prefix.
- Named collection preferred over inline credentials.
- `BACKUP_CREATED` accepted.
- Failed, cancelled, unknown, and timed-out operations rejected.
- Operation ID, database, sizes, and versions recorded.

Run: `pnpm test test/adapters/clickhouse`

Expected: FAIL because the adapter does not exist.

**Step 2: Implement native backup**

Issue `BACKUP DATABASE` over ClickHouse HTTP. Use a named collection when
configured; permit inline HMAC only for local integration tests. Poll
`system.backups` with bounded exponential backoff.

**Step 3: Run integration test**

Run: `pnpm test test/integration/clickhouseBackup.test.ts`

Expected: backup status is `BACKUP_CREATED` and its remote prefix is non-empty.

**Step 4: Commit**

```bash
git add src/adapters/clickhouse test/adapters/clickhouse
git add test/integration/clickhouseBackup.test.ts
git commit -m "feat: back up ClickHouse to GCS"
```

### Task 5: Orchestrate and commit a foundation backup

**Files:**

- Create: `src/orchestration/createBackup.ts`
- Create: `src/orchestration/verifyBackup.ts`
- Create: `src/commands/create.ts`
- Create: `src/commands/list.ts`
- Create: `src/commands/inspect.ts`
- Create: `src/commands/verify.ts`
- Modify: `src/cli.ts`
- Test: `test/orchestration/createBackup.test.ts`
- Integration: `test/integration/foundationBackup.test.ts`

**Step 1: Write the failing orchestration test**

Assert ordering:

```text
lock -> preflight -> postgres -> clickhouse -> verify -> manifest -> unlock
```

Inject a failure at every stage and assert no manifest exists.

Run: `pnpm test test/orchestration/createBackup.test.ts`

Expected: FAIL because the orchestrator does not exist.

**Step 2: Implement the minimal commands**

`create` supports online consistency only in this phase and requires
`--allow-active-writes`. The manifest must say `consistency.mode = "online"`.

`list`, `inspect`, and `verify` operate only on prefixes containing a valid
manifest.

**Step 3: Run integration verification**

Run: `pnpm test test/integration/foundationBackup.test.ts`

Expected: one committed manifest references verified PostgreSQL and ClickHouse
receipts, while an injected failure leaves staging artifacts without a manifest.

**Step 4: Run the full gate**

Run: `pnpm verify`

Expected: lint, typecheck, all tests, and build pass.

**Step 5: Commit**

```bash
git add src/commands src/orchestration src/cli.ts
git add test/orchestration test/integration/foundationBackup.test.ts
git commit -m "feat: create verifiable foundation backups"
```

## Exit Criteria

- PostgreSQL and ClickHouse receipts are based on direct provider evidence.
- `manifest.json` is written only after receipt verification.
- Failed backups remain visibly incomplete.
- All secret-bearing errors and command arguments are redacted.
- Foundation integration tests restore PostgreSQL and observe ClickHouse backup
  completion.
- `pnpm verify` passes.

