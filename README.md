# langfuse-backup

Planning workspace for an open-source backup and restore tool for self-hosted
Langfuse.

The planned product is a standalone CLI and OCI image. It coordinates native
PostgreSQL, ClickHouse, Redis queue, and blob-storage capabilities to create a
versioned and verifiable recovery point. It does not introduce a custom database
backup format.

## Initial Scope

- Self-hosted Langfuse deployed with Docker Compose.
- PostgreSQL through `pg_dump` and `pg_restore`.
- Single-node ClickHouse through native `BACKUP` and `RESTORE`.
- Redis ingestion queue drain verification.
- Active MinIO, GCS, or S3-compatible blob storage.
- GCS as the first backup destination.
- Coordinated and explicitly weaker online consistency modes.
- Machine-readable manifests and isolated restore verification.

## Documents

- [Architecture](docs/architecture.md)
- [Project bootstrap](docs/plans/2026-07-24-00-project-bootstrap.md)
- [Backup foundation](docs/plans/2026-07-24-01-backup-foundation.md)
- [Consistency and blob storage](docs/plans/2026-07-24-02-consistency-and-blob-storage.md)
- [Restore validation](docs/plans/2026-07-24-03-restore-validation.md)
- [OSS release](docs/plans/2026-07-24-04-oss-release.md)
- [Progress](progress.md)

## Planning Principles

1. A backup is not valid until every required component has a verified receipt.
2. `manifest.json` is written last and acts as the recovery-point commit marker.
3. Credentials and encryption keys never appear in manifests or logs.
4. Coordinated mode fails closed when ingestion or queue activity remains.
5. Restore is tested only against a separate, empty target deployment.
6. Provider adapters reuse native backup APIs instead of reimplementing them.

## Current Status

Planning only. No package code has been implemented yet. Follow
[progress.md](progress.md) for completed work, loop evidence, decisions, risks,
and the next executable milestone.
