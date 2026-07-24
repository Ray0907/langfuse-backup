# Restore Validation Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement
> this plan task-by-task.

**Goal:** Restore a committed recovery point into a separate empty Docker
Compose deployment and prove the restored Langfuse data is usable.

**Architecture:** Separate read-only planning from destructive execution.
Validate target identity, versions, secrets, and emptiness before restoring blob
storage, PostgreSQL, and ClickHouse in a controlled order.

**Tech Stack:** TypeScript, PostgreSQL client tools, ClickHouse native restore,
GCS and S3-compatible SDKs, Docker Compose test fixtures, Vitest.

---

## Dependency

Complete
[Consistency and Blob Storage](2026-07-24-02-consistency-and-blob-storage.md)
before this plan.

### Task 1: Build a read-only restore planner

**Files:**

- Create: `src/restore/restorePlan.ts`
- Create: `src/restore/checkTarget.ts`
- Create: `src/commands/restorePlan.ts`
- Modify: `src/cli.ts`
- Test: `test/restore/restorePlan.test.ts`

**Step 1: Write failing target-safety tests**

Reject:

- Source and target deployment IDs that match.
- Non-empty target databases.
- Unsupported Langfuse, PostgreSQL, or ClickHouse versions.
- Missing required secret references.
- Missing or mismatched component artifacts.
- Online backups unless `--accept-online-consistency` is explicit.

Run: `pnpm test test/restore/restorePlan.test.ts`

Expected: FAIL because the planner does not exist.

**Step 2: Implement the read-only plan**

The command prints ordered actions, required downtime, estimated artifact sizes,
version checks, and every destructive operation. It does not create, delete, or
modify target data.

**Step 3: Verify**

Run: `pnpm test test/restore/restorePlan.test.ts`

Expected: all restore-plan tests pass.

**Step 4: Commit**

```bash
git add src/restore src/commands/restorePlan.ts src/cli.ts test/restore
git commit -m "feat: plan safe Langfuse restores"
```

### Task 2: Restore blob storage

**Files:**

- Create: `src/restore/restoreBlobStorage.ts`
- Test: `test/restore/restoreBlobStorage.test.ts`
- Integration: `test/integration/restoreBlobStorage.test.ts`

**Step 1: Write failing restore tests**

Cover versioned GCS references, MinIO-copy backups, checksum mismatches,
pre-existing target objects, and interrupted restores.

Run: `pnpm test test/restore/restoreBlobStorage.test.ts`

Expected: FAIL because blob restore does not exist.

**Step 2: Implement restore into an empty target prefix**

Do not overwrite a target object unless the operator explicitly selected a
separate overwrite mode. Write a target restore journal after each verified
object so interruption can resume safely.

**Step 3: Run integration test**

Run: `pnpm test test/integration/restoreBlobStorage.test.ts`

Expected: raw events and media match the inventory checksums.

**Step 4: Commit**

```bash
git add src/restore/restoreBlobStorage.ts
git add test/restore/restoreBlobStorage.test.ts
git add test/integration/restoreBlobStorage.test.ts
git commit -m "feat: restore Langfuse blob storage"
```

### Task 3: Restore PostgreSQL

**Files:**

- Create: `src/restore/restorePostgres.ts`
- Test: `test/restore/restorePostgres.test.ts`
- Integration: `test/integration/restorePostgres.test.ts`

**Step 1: Write failing restore tests**

Require an empty target database and compatible `pg_restore` version. Preserve
stderr, restore exit code, and redaction evidence.

Run: `pnpm test test/restore/restorePostgres.test.ts`

Expected: FAIL because the adapter does not exist.

**Step 2: Implement restore**

Download and verify the dump before invoking `pg_restore`. Do not use
`--clean` in the MVP because the target must already be empty.

**Step 3: Run integration test**

Run: `pnpm test test/integration/restorePostgres.test.ts`

Expected: seeded users, project, prompt, dataset, and API-key records exist.

**Step 4: Commit**

```bash
git add src/restore/restorePostgres.ts test/restore
git add test/integration/restorePostgres.test.ts
git commit -m "feat: restore Langfuse PostgreSQL"
```

### Task 4: Restore ClickHouse

**Files:**

- Create: `src/restore/restoreClickhouse.ts`
- Test: `test/restore/restoreClickhouse.test.ts`
- Integration: `test/integration/restoreClickhouse.test.ts`

**Step 1: Write failing status tests**

Accept only `RESTORED`. Reject partial, failed, cancelled, unknown, and timed-out
operations. Confirm the target database is empty before issuing SQL.

Run: `pnpm test test/restore/restoreClickhouse.test.ts`

Expected: FAIL because the adapter does not exist.

**Step 2: Implement native restore**

Issue `RESTORE DATABASE` using the same named collection and backup prefix.
Record the restore operation ID and provider evidence in the restore journal.

**Step 3: Run integration test**

Run: `pnpm test test/integration/restoreClickhouse.test.ts`

Expected: known traces, observations, and scores are queryable.

**Step 4: Commit**

```bash
git add src/restore/restoreClickhouse.ts
git add test/restore/restoreClickhouse.test.ts
git add test/integration/restoreClickhouse.test.ts
git commit -m "feat: restore Langfuse ClickHouse"
```

### Task 5: Orchestrate destructive restore

**Files:**

- Create: `src/restore/runRestore.ts`
- Create: `src/commands/restoreRun.ts`
- Modify: `src/cli.ts`
- Test: `test/restore/runRestore.test.ts`

**Step 1: Write the failing orchestration test**

Assert:

```text
plan -> confirmation -> target lock -> blob -> PostgreSQL -> ClickHouse
     -> health checks -> smoke tests -> report -> unlock
```

Any failure marks the target journal dirty. A dirty target cannot resume a
different backup.

**Step 2: Implement explicit confirmation**

Require:

```text
--target <config>
--confirm
--expected-backup-id <backup-id>
```

Interactive confirmation is supplementary and never replaces these flags in
automation.

Run: `pnpm test test/restore/runRestore.test.ts`

Expected: all orchestration safety tests pass.

**Step 3: Commit**

```bash
git add src/restore/runRestore.ts src/commands/restoreRun.ts
git add src/cli.ts test/restore/runRestore.test.ts
git commit -m "feat: orchestrate explicit Langfuse restore"
```

### Task 6: Prove backup-destroy-restore-verify

**Files:**

- Create: `test/fixtures/docker-compose.source.yml`
- Create: `test/fixtures/docker-compose.target.yml`
- Create: `test/e2e/recovery.test.ts`
- Create: `scripts/run-recovery-e2e.sh`
- Modify: `.github/workflows/ci.yml`

**Step 1: Create isolated Compose projects**

Use different Compose project names, networks, volumes, ports, credentials, and
deployment IDs. Never point the test at a developer's default Compose project.

**Step 2: Seed representative data**

Seed:

- User, organization, project, and API key.
- Prompt and dataset.
- Trace, observation, and score.
- Media object and raw ingestion event.

**Step 3: Run the recovery test**

Run: `bash scripts/run-recovery-e2e.sh`

Expected summary:

```text
Recovery E2E passed: backup committed, source destroyed, target restored,
PostgreSQL verified, ClickHouse verified, blobs verified, API smoke test passed.
```

A zero-test run or restore without source destruction is a failure.

**Step 4: Add scheduled CI**

Run the recovery test nightly and before release. Upload logs and recovery
reports on failure without uploading credentials.

**Step 5: Commit**

```bash
git add test/fixtures test/e2e scripts/run-recovery-e2e.sh
git add .github/workflows/ci.yml
git commit -m "test: prove full Langfuse disaster recovery"
```

## Exit Criteria

- Restore planning is read-only and identifies every destructive operation.
- Restore cannot target the source deployment or a non-empty target.
- Missing secrets and version incompatibilities fail before data changes.
- Interrupted restore leaves an explicit dirty journal.
- The E2E test destroys the source before validating the target.
- Health, PostgreSQL, ClickHouse, blobs, and one public API read all pass.

