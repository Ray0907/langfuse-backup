# langfuse-backup

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Standalone backup and restore tooling for self-hosted Langfuse.

`langfuse-backup` coordinates native PostgreSQL and ClickHouse backups, drains
Langfuse ingestion queues, inventories or copies blob objects, and commits one
verifiable recovery manifest. It runs independently from the Langfuse web and
worker processes, so an application outage does not remove the recovery path.

> [!IMPORTANT]
> This project is pre-release. The component-level backup-destroy-restore test
> passes, but a complete released Langfuse application image has not yet passed
> the same recovery E2E. No npm or GHCR artifact has been published. Review the
> [compatibility matrix](docs/compatibility.md) before production use.

## What it protects

| Component | Backup mechanism | Restore mechanism |
| --- | --- | --- |
| PostgreSQL | Custom `pg_dump` plus SHA-256 | Verified `pg_restore` to empty DB |
| ClickHouse | Async native `BACKUP` | Async native `RESTORE` |
| Redis/BullMQ | Queue drain; no data archive | Not restored |
| GCS blobs | Version/generation inventory | Generation-pinned reads |
| S3/MinIO blobs | Verified copy to recovery GCS | Verified copy to target GCS |

A backup is committed only when every component receipt has passed verification
and `manifest.json` is written last. Incomplete staging prefixes are not recovery
points.

## Recovery guarantees and limits

The implemented safety contract provides:

- One manifest-last commit marker for each recovery point.
- Coordinated mode that blocks new ingestion, drains known BullMQ queues, and
  fails closed on pending or failed jobs.
- Immutable object writes with GCS generation preconditions.
- Native provider-readable database artifacts rather than a proprietary archive.
- Size and checksum verification before restore clients receive an artifact.
- A read-only restore plan before any target write.
- A distinct target deployment ID, empty-target checks, an exact expected backup
  ID, `--confirm`, a target lock, resumable journals, health checks, and a required
  application smoke-test hook.

It does not provide a distributed transaction across PostgreSQL, ClickHouse, and
blob storage. Coordinated mode creates an operational boundary by stopping new
ingestion and draining queues. Online mode is independently consistent per
component and must be explicitly accepted during both backup and restore.

## Requirements

- Node.js 24 or the included OCI build.
- `pnpm` 11 for source builds.
- PostgreSQL 17 client tools (`pg_dump`, `psql`, and `pg_restore`).
- A ClickHouse HTTP endpoint with native backup/restore privileges.
- Redis access that can read BullMQ queue counts.
- A GCS recovery bucket.
- Docker with Compose only for the container and recovery test suites.

The initial production boundary is Docker Compose and GCS. Kubernetes, Azure
Blob Storage, filesystem production destinations, and non-empty restore targets
are not supported.

## Install from source

Until the first signed release is published, build from a reviewed commit:

```bash
git clone https://github.com/Ray0907/langfuse-backup.git
cd langfuse-backup
corepack enable
pnpm install --frozen-lockfile
pnpm verify
node dist/cli.js --version
```

Or build the non-root OCI image:

```bash
docker build \
  --build-arg SOURCE_REVISION="$(git rev-parse HEAD)" \
  --build-arg TOOL_VERSION="$(node -p 'require("./package.json").version')" \
  -t langfuse-backup:local .
docker run --rm langfuse-backup:local --version
```

Do not install an npm package named `langfuse-backup` until this repository links
to a signed release. The project does not use or claim the `@langfuse` namespace.

## Prepare the source

Copy [the backup configuration](examples/config.example.yaml):

```bash
cp examples/config.example.yaml backup.yaml
```

The minimum shape is:

```yaml
deployment_id: langfuse-production
langfuse_version: 3.205.0
consistency:
  mode: coordinated
  pre_hook:
    command: [/usr/local/bin/block-langfuse-ingestion]
  post_hook:
    command: [/usr/local/bin/unblock-langfuse-ingestion]
destination:
  provider: gcs
  bucket: example-langfuse-backups
  prefix: recovery-points
postgres:
  url:
    env: LANGFUSE_POSTGRES_URL
clickhouse:
  endpoint: http://clickhouse:8123
  database: default
  named_collection: langfuse_backup
redis:
  url:
    file: /run/secrets/redis_url
blob:
  provider: gcs
  bucket: example-langfuse-events
```

Secret-bearing fields accept only one of these forms:

```yaml
url:
  env: LANGFUSE_POSTGRES_URL
```

```yaml
url:
  file: /run/secrets/postgres_url
```

Inline database URLs, passwords, access keys, and service-account JSON are
rejected. A GCS credential reference must contain a JSON service account;
omitting it uses Google Application Default Credentials or workload identity.

Before the first backup:

1. Enable object versioning on a GCS source blob bucket, or set
   `immutable_bucket: true` only when an external policy genuinely prevents
   mutation.
2. Configure the ClickHouse named collection to write its native backup prefix
   at the root of the configured GCS recovery bucket through its S3-compatible
   endpoint.
3. Grant the backup identity read access to source systems and create/read/list
   access only to the configured recovery prefix.
4. Make the pre-hook block new Langfuse ingestion while workers continue draining
   queues. Make the post-hook re-enable ingestion and safe to retry.

See the [credential matrix](docs/security/credential-matrix.md) for minimum
source and restore privileges.

## Create and verify a recovery point

All commands print JSON on stdout and redacted diagnostics on stderr.

Check connectivity and versions:

```bash
node dist/cli.js doctor --config backup.yaml
```

Create a coordinated recovery point:

```bash
node dist/cli.js create \
  --config backup.yaml \
  --backup-id backup-20260727T120000Z
```

If `--backup-id` is omitted, the CLI creates a UTC timestamp-based ID. When the
CLI runs inside its OCI image, hooks are disabled by default; use
`--allow-container-hooks` only after mounting and reviewing the hook executables.

Online backup is explicit:

```bash
node dist/cli.js create \
  --config backup.yaml \
  --backup-id backup-online-20260727 \
  --allow-active-writes
```

List, inspect, and verify committed recovery points:

```bash
node dist/cli.js list --config backup.yaml
node dist/cli.js inspect \
  --config backup.yaml \
  --backup-id backup-20260727T120000Z
node dist/cli.js verify \
  --config backup.yaml \
  --backup-id backup-20260727T120000Z
```

`verify` checks manifest identity plus PostgreSQL and blob inventory size and
SHA-256 metadata. ClickHouse native completion evidence is recorded in the
manifest and checked again while planning a restore.

## Retention

Pruning is a dry run unless `--confirm` is present:

```bash
node dist/cli.js prune \
  --config backup.yaml \
  --keep-daily 7 \
  --keep-weekly 4
```

Review `keep_ids` and `delete_ids`, then repeat with `--confirm`. The command
removes the selected manifest first so a partially deleted prefix immediately
stops being a valid recovery point. It never deletes incomplete staging prefixes
automatically.

## Restore into an isolated target

Copy [the restore target configuration](examples/restore-target.example.yaml):

```bash
cp examples/restore-target.example.yaml restore-target.yaml
```

The target configuration has separate PostgreSQL, ClickHouse, and GCS
credentials. Its `smoke_test` is required and must prove that the restored
Langfuse application can serve a known read:

```yaml
deployment_id: langfuse-recovery-drill
langfuse_version: 3.205.0
secret_references: []
postgres:
  url:
    env: LANGFUSE_TARGET_POSTGRES_URL
clickhouse:
  endpoint: http://clickhouse-target:8123
  database: default
  named_collection: langfuse_backup
blob:
  provider: gcs
  bucket: example-langfuse-restore-target
smoke_test:
  command: [/usr/local/bin/check-restored-langfuse]
```

The target deployment ID must differ from the source. PostgreSQL, ClickHouse,
and the configured target blob prefix must all be empty. The target ClickHouse
named collection must read the same native backup root used during creation.

Generate a read-only plan:

```bash
node dist/cli.js restore plan \
  --config backup.yaml \
  --target restore-target.yaml \
  --backup-id backup-20260727T120000Z
```

The plan checks deployment identity, versions, required secret references,
target emptiness, artifact metadata, and the ClickHouse backup prefix. It prints
ordered destructive actions but does not acquire a lock or modify either
deployment.

Run the restore only after reviewing that plan:

```bash
node dist/cli.js restore run \
  --config backup.yaml \
  --target restore-target.yaml \
  --expected-backup-id backup-20260727T120000Z \
  --confirm
```

For an online backup, both plan and run additionally require
`--accept-online-consistency`. Restore writes blobs, PostgreSQL, and ClickHouse
in that order, runs health checks and the configured smoke test, then writes a
report. A failure marks the target journal dirty; a different backup ID cannot
reuse that journal.

## Run the OCI image

Mount configuration and secret files read-only. The container runs as
`10001:10001` and includes PostgreSQL 17 clients:

```bash
docker run --rm \
  --network langfuse_default \
  --mount type=bind,src="$PWD/backup.yaml",dst=/config/backup.yaml,readonly \
  --mount type=bind,src="$PWD/secrets",dst=/run/secrets,readonly \
  -e LANGFUSE_POSTGRES_URL \
  langfuse-backup:local \
  doctor --config /config/backup.yaml
```

Use workload identity where available. Avoid passing long-lived provider
credentials as plain command arguments.

## Recovery evidence

The repository recovery test creates isolated source, recovery-store, and target
services with unique networks, volumes, ports, credentials, and deployment IDs.
It seeds representative Langfuse records, commits a backup, destroys the source
containers and volumes, restores the target, and verifies:

- PostgreSQL users, organizations, projects, API keys, prompts, and datasets.
- ClickHouse traces, observations, and scores.
- Raw-event and media blobs.
- A synthetic HTTP API read across the restored component data.

Run it locally:

```bash
bash scripts/run-recovery-e2e.sh
```

This proves the component orchestration and destructive recovery sequence. It
does not yet prove the complete schema, migrations, or API behavior of a
released Langfuse image. That distinction is tracked in
[docs/compatibility.md](docs/compatibility.md).

## Security

- Review the [threat model](docs/security/threat-model.md).
- Keep credentials and customer data out of issues, logs, fixtures, and commits.
- Report suspected vulnerabilities through GitHub Private Vulnerability
  Reporting, as described in [SECURITY.md](SECURITY.md).
- Treat hooks, native database clients, backup objects, and provider errors as
  untrusted inputs.
- Use separate identities for production reads, recovery storage, and restore
  target writes.

The release workflow scans Git history for secrets, audits dependencies, scans
source and OCI artifacts for vulnerabilities, produces provenance and SBOMs,
and signs release images with keyless Cosign. It remains dormant until a
maintainer creates an approved version tag and protected release environment.

## Development

Requirements are Node.js 24, pnpm 11, and Docker with Compose:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm verify
node scripts/verify-plans.mjs
docker build -t langfuse-backup:test .
bash test/container/smoke.sh langfuse-backup:test
bash scripts/run-recovery-e2e.sh
node scripts/verify-artifact.mjs
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for pull-request gates. Backup, restore,
manifest, consistency, or provider changes require the recovery E2E.

## Project documentation

- [Architecture](docs/architecture.md)
- [Compatibility](docs/compatibility.md)
- [Threat model](docs/security/threat-model.md)
- [Credential matrix](docs/security/credential-matrix.md)
- [Releasing](docs/releasing.md)
- [Upstream proposal](docs/upstream-proposal.md)
- [Changelog](CHANGELOG.md)
- [Governance](GOVERNANCE.md)
- [Support](SUPPORT.md)
- [Implementation progress](progress.md)

This is an independent community project. It is not maintained or endorsed by
Langfuse.
