# Consistency and Blob Storage Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement
> this plan task-by-task.

**Goal:** Upgrade foundation backups into coordinated, complete recovery points
that include Langfuse blob storage.

**Architecture:** Block new ingestion with operator hooks, prove all ingestion
queues are drained, capture a common boundary, and add a provider-specific blob
receipt before committing the manifest.

**Tech Stack:** TypeScript, BullMQ, Redis, GCS SDK, AWS S3 SDK, MinIO-compatible
S3 API, Vitest, Docker Compose.

---

## Dependency

Complete
[Backup Foundation](2026-07-24-01-backup-foundation.md) before this plan.

### Task 1: Discover and inspect ingestion queues

**Files:**

- Create: `src/adapters/redis/queueNames.ts`
- Create: `src/adapters/redis/queueInspector.ts`
- Test: `test/adapters/redis/queueNames.test.ts`
- Integration: `test/integration/queueInspector.test.ts`

**Step 1: Write failing queue tests**

Cover base and configured shard names for:

- `ingestion-queue`
- `secondary-ingestion-queue`
- `otel-ingestion-queue`
- `secondary-otel-ingestion-queue`

Waiting, active, prioritized, delayed, and waiting-child states must be visible.

Run: `pnpm test test/adapters/redis`

Expected: FAIL because queue discovery does not exist.

**Step 2: Implement the inspector**

Use BullMQ-compatible APIs and a dedicated read-only Redis connection. Return a
snapshot with counts and timestamp. Do not mutate, pause, resume, retry, or
delete jobs.

**Step 3: Run integration test**

Run: `pnpm test test/integration/queueInspector.test.ts`

Expected: seeded jobs appear in the correct states and disappear after workers
complete them.

**Step 4: Commit**

```bash
git add src/adapters/redis test/adapters/redis
git add test/integration/queueInspector.test.ts
git commit -m "feat: inspect Langfuse ingestion queues"
```

### Task 2: Add safe maintenance hooks and queue drain

**Files:**

- Create: `src/orchestration/runHook.ts`
- Create: `src/orchestration/waitForQueueDrain.ts`
- Create: `src/orchestration/consistencyGate.ts`
- Test: `test/orchestration/runHook.test.ts`
- Test: `test/orchestration/waitForQueueDrain.test.ts`

**Step 1: Write failing safety tests**

Assert:

- Hooks are disabled inside the OCI image by default.
- Hook timeouts preserve output and run the post-hook when possible.
- Drain requires two consecutive empty snapshots.
- Failed and delayed jobs are reported, not silently discarded.
- A drain timeout prevents backup component execution.

Run: `pnpm test test/orchestration`

Expected: FAIL because consistency-gate modules do not exist.

**Step 2: Implement the consistency gate**

Host mode runs configured commands without a shell unless the configuration
explicitly selects shell mode. Coordinated mode records the second empty queue
snapshot as `queue_drained_at`.

**Step 3: Verify**

Run: `pnpm test test/orchestration`

Expected: all hook and queue-drain tests pass.

**Step 4: Commit**

```bash
git add src/orchestration test/orchestration
git commit -m "feat: coordinate ingestion maintenance window"
```

### Task 3: Implement GCS versioned inventory

**Files:**

- Create: `src/blob/types.ts`
- Create: `src/blob/gcsInventory.ts`
- Create: `src/blob/writeInventory.ts`
- Test: `test/blob/gcsInventory.test.ts`
- Integration: `test/integration/gcsInventory.test.ts`

**Step 1: Write failing inventory tests**

Cover pagination, object generations, deleted live versions, checksums, prefix
selection, empty prefixes, and bounded memory use.

Run: `pnpm test test/blob/gcsInventory.test.ts`

Expected: FAIL because inventory support does not exist.

**Step 2: Implement streaming NDJSON inventory**

Require GCS object versioning or an explicit immutable-bucket guarantee.
Stream object metadata into gzip-compressed NDJSON and upload it to staging.
Never retain the full inventory in memory.

**Step 3: Run integration test**

Run: `pnpm test test/integration/gcsInventory.test.ts`

Expected: every seeded object generation appears once and its checksum verifies.

**Step 4: Commit**

```bash
git add src/blob test/blob test/integration/gcsInventory.test.ts
git commit -m "feat: inventory versioned GCS blobs"
```

### Task 4: Implement MinIO and S3-compatible blob copy

**Files:**

- Create: `src/blob/s3Source.ts`
- Create: `src/blob/copyBlobPrefix.ts`
- Test: `test/blob/copyBlobPrefix.test.ts`
- Integration: `test/integration/minioBlobBackup.test.ts`

**Step 1: Write failing copy tests**

Cover multipart objects, retries, ETags that are not MD5, existing immutable
destination objects, and interruption before receipt creation.

Run: `pnpm test test/blob/copyBlobPrefix.test.ts`

Expected: FAIL because the copy adapter does not exist.

**Step 2: Implement bounded streaming copy**

Read from S3-compatible storage and write to GCS with bounded concurrency.
Record source ETag, destination generation, size, and destination checksum.
Required prefixes are `events/` and `media/`.

**Step 3: Run MinIO integration test**

Run: `pnpm test test/integration/minioBlobBackup.test.ts`

Expected: copied raw events and media validate in GCS; batch exports are omitted.

**Step 4: Commit**

```bash
git add src/blob test/blob test/integration/minioBlobBackup.test.ts
git commit -m "feat: copy MinIO blobs to GCS"
```

### Task 5: Commit coordinated recovery points

**Files:**

- Modify: `src/orchestration/createBackup.ts`
- Modify: `src/manifest/schema.ts`
- Modify: `src/commands/create.ts`
- Test: `test/orchestration/coordinatedBackup.test.ts`
- Integration: `test/integration/coordinatedBackup.test.ts`

**Step 1: Write the failing end-to-end test**

Send a known ingestion event, block new ingestion, wait for queues to drain, and
assert the manifest boundary comes before every component receipt.

Run: `pnpm test test/integration/coordinatedBackup.test.ts`

Expected: FAIL because coordinated mode is not wired.

**Step 2: Implement coordinated mode**

Required order:

```text
lock -> pre-hook -> drain -> boundary -> PostgreSQL -> ClickHouse
     -> blob -> verify -> manifest -> post-hook -> unlock
```

The post-hook runs in `finally`. Any non-empty queue snapshot prevents manifest
commit.

**Step 3: Verify**

Run: `pnpm test test/integration/coordinatedBackup.test.ts`

Expected: the coordinated manifest contains all component receipts and the
queue-drain boundary.

Run: `pnpm verify`

Expected: all repository gates pass.

**Step 4: Commit**

```bash
git add src/commands/create.ts src/manifest/schema.ts
git add src/orchestration test/orchestration test/integration
git commit -m "feat: create coordinated Langfuse recovery points"
```

### Task 6: Add retention planning and pruning

**Files:**

- Create: `src/retention/selectRecoveryPoints.ts`
- Create: `src/commands/prune.ts`
- Modify: `src/cli.ts`
- Test: `test/retention/selectRecoveryPoints.test.ts`

**Step 1: Write failing retention tests**

Cover daily and weekly retention, incomplete staging prefixes, base backups,
locked recovery points, dry-run output, and clock boundaries.

**Step 2: Implement selection and dry-run**

`prune` defaults to dry-run. Deletion requires `--confirm` and refuses to remove
artifacts needed by retained incremental backups.

Run: `pnpm test test/retention`

Expected: retention selection tests pass.

**Step 3: Commit**

```bash
git add src/retention src/commands/prune.ts src/cli.ts test/retention
git commit -m "feat: plan backup retention safely"
```

## Exit Criteria

- Coordinated mode proves ingestion queues are drained before the boundary.
- Raw events and media have a recoverable blob receipt.
- GCS inventory memory use is bounded.
- MinIO copy is resumable without accepting mismatched existing objects.
- Post-hooks execute on every failure path.
- Online mode remains explicit and clearly labeled.
- `pnpm verify` and the coordinated integration test pass.

