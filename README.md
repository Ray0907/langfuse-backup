# langfuse-backup

Standalone open-source backup and restore tooling for self-hosted Langfuse.

The package provides a TypeScript CLI and OCI image. It coordinates native
PostgreSQL, ClickHouse, Redis queue, and blob-storage capabilities to create a
versioned and verifiable recovery point. It does not introduce a custom database
backup format.

## Status

Implementation is in progress on the ordered plans below. Commands that have not
reached their verified milestone fail with `NOT_IMPLEMENTED` instead of claiming
that a backup succeeded.

## Development

Requirements are Node.js 24, pnpm 11, and Docker with Compose.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm verify
docker build -t langfuse-backup:test .
bash test/container/smoke.sh langfuse-backup:test
```

Start from [examples/config.example.yaml](examples/config.example.yaml). Secret
values must use environment-variable or mounted-file references.

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

Follow [progress.md](progress.md) for verified milestones, evidence, decisions,
risks, and the next executable task.
