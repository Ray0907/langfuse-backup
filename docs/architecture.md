# Architecture

## Product Boundary

`langfuse-backup` runs independently from Langfuse web and worker containers.
The first distribution targets a host-installed CLI and an OCI image. The CLI
does not require the Docker socket and does not expose backup controls through
the production Langfuse UI or API.

The tool coordinates existing systems:

```text
CLI
 |
 +-- configuration and secret references
 +-- destination lock and state machine
 +-- consistency gate
 +-- PostgreSQL adapter
 +-- ClickHouse adapter
 +-- Redis queue inspector
 +-- blob-storage adapter
 +-- manifest writer and verifier
 `-- restore planner and runner
```

## Runtime

- Node.js 24 and TypeScript.
- `pnpm` for dependency and workspace management.
- `pg_dump` and `pg_restore` supplied by the OCI image.
- ClickHouse HTTP client for native `BACKUP` and `RESTORE` SQL.
- BullMQ-compatible Redis inspection for queue drain checks.
- Native provider SDKs for GCS and later S3.
- Zod for configuration, receipts, and manifest schemas.
- Vitest for unit and integration tests.

The first implementation stays in one package. Provider interfaces remain
internal modules until a second provider proves that a public plugin API is
necessary.

## Recovery-Point State Machine

```text
created
  -> locked
  -> preflight_passed
  -> quiesced
  -> postgres_complete
  -> clickhouse_complete
  -> blob_complete
  -> verified
  -> committed
```

Any failure before `committed` leaves diagnostic staging artifacts but does not
write the final manifest. A retry may reuse an immutable artifact only when its
receipt and remote metadata still validate.

## Consistency

Coordinated mode is the default. An operator-provided hook blocks new ingestion,
the worker remains active until ingestion queues reach zero, and the backup
boundary is recorded before component backups begin. The tool then backs up
PostgreSQL, ClickHouse, and blob storage.

Online mode requires `--allow-active-writes`. It produces independently
consistent component backups and records their time ranges. The manifest labels
this mode explicitly and never presents it as a global checkpoint.

The tool does not claim a distributed transaction. Coordinated mode provides a
recoverable operational boundary by preventing new application writes during
the backup window.

## Component Contracts

### PostgreSQL

Create a custom-format dump, calculate SHA-256, upload to the destination, and
verify size and checksum metadata. Record server and client versions.

### ClickHouse

Use native `BACKUP DATABASE` to the GCS S3-compatible endpoint. Poll
`system.backups` and accept only `BACKUP_CREATED`. Production deployments use a
ClickHouse named collection so HMAC secrets do not appear in query logs.

### Redis

Inspect waiting and active counts for ingestion, secondary ingestion,
OpenTelemetry ingestion, and configured shard queues. Redis is not a durable
component backup in the MVP. Coordinated mode requires these queues to drain.

### Blob storage

For versioned GCS or S3, record an inventory of object names, generations or
version IDs, sizes, and checksums. For MinIO, copy required prefixes to the
backup destination. Raw events and media are required; batch exports are
optional.

## Manifest

The manifest contains:

- Schema, deployment, and backup IDs.
- Consistency mode and queue-drain boundary.
- Langfuse, PostgreSQL, and ClickHouse versions.
- Component receipts, checksums, object paths, and operation IDs.
- Required secret names without secret values.
- Verification timestamps and tool version.

The final `manifest.json` is the commit marker. Restore and pruning commands
ignore staging prefixes without a valid manifest.

## Security Boundary

- Secrets come from environment variables, mounted files, workload identity,
  or ClickHouse named collections.
- A central redactor processes logs and adapter errors.
- The destination service account is scoped to one backup bucket.
- Restore requires a separate target configuration and explicit confirmation.
- Source and target deployment IDs must differ.
- The CLI never automatically deletes or recreates a database.

