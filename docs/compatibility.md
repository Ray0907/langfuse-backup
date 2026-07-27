# Compatibility

Last verified: 2026-07-27.

The labels below are deliberate:

- **Recovery E2E:** used in the source-destroy-target-restore test.
- **Targeted:** covered by adapter unit or container integration tests.
- **Inspected:** version metadata or startup was checked, but recovery was not.
- **Expected:** follows a documented protocol and remains unverified here.
- **Unsupported:** intentionally outside the initial contract.

## Verified matrix

| Component | Version or digest | Evidence | Status |
| --- | --- | --- | --- |
| Node.js | 24.18.0 local; 24.4.1 CI floor | Build, unit, integration, recovery runner | Recovery E2E |
| pnpm | 11.0.0 | Frozen install and all verification commands | Recovery E2E |
| PostgreSQL | 17.10, `postgres@sha256:4f736a…b394` | Native custom dump, source deletion, empty-target restore, row reads | Recovery E2E |
| ClickHouse | 26.3.9.8, `clickhouse-server@sha256:537014…db62` | Native S3 backup/restore, operation polling, row reads | Recovery E2E |
| MinIO | `RELEASE.2025-09-07T16-13-09Z`, `sha256:14cea4…936e` | Raw-event and media copy, inventory, target reads | Recovery E2E |
| BullMQ | 5.80.12 | Queue names, counts, failure and drain behavior | Targeted |
| Redis | 7.4.9, `redis@sha256:b2b956…2e50` | Image/version inspection only | Inspected |
| GCS SDK | `@google-cloud/storage` 7.21.0 | Generation preconditions, inventory, locks via protocol fixtures | Targeted |
| Langfuse | Image 3.205.0, `langfuse@sha256:273ff1…4923` | Image metadata only; representative schema/API fixture in E2E | Inspected |

Full digests are recorded in Docker and Compose fixtures. Shortened values in
the table are for readability.

The recovery evidence above was generated locally with Node.js 24.18.0. GitHub
Actions is pinned to the earlier supported Node.js 24.4.1 floor; a green hosted
run is separate evidence and is not implied by this local matrix.

## Compatibility contract

### Langfuse

The manifest schema records a Langfuse version, and restore requires the same
major version. The current adapters model the Langfuse v3 component topology:
PostgreSQL identity/configuration data, ClickHouse trace/observation/score data,
Redis/BullMQ ingestion queues, and raw-event/media blob prefixes.

A full released Langfuse 3.205.0 application restore has not yet passed. Treat
v3 compatibility as **expected**, not stable-release evidence. Langfuse v4 is
unsupported until its final self-hosted migration and storage contracts receive
new fixtures and recovery proof.

### PostgreSQL

PostgreSQL restore requires the same major `pg_restore` version as the dump
client and an empty target. PostgreSQL 17 is tested. PostgreSQL 15 and 16 are
expected to work with matching client tools but are not verified.

### ClickHouse

ClickHouse restore requires matching major and minor server versions, an empty
target database, and the same named S3 collection. Version 26.3.9.8 is tested.
Other 26.3 patch versions are expected; other minor versions are unverified.

### Redis and queues

Redis is not a durable backup component. Coordinated mode reads BullMQ-compatible
queue counts and requires pending and failed totals to reach zero. Redis 7 and
Valkey compatibility are expected but do not yet have a live recovery test.

### Blob and recovery providers

MinIO's S3-compatible API is tested for copied blobs and ClickHouse native
backup objects. GCS generation semantics and the S3-compatible endpoint contract
are covered by protocol fixtures, not a live GCP project. Azure Blob Storage,
filesystem-only production destinations, and unversioned mutable source buckets
without copy mode are unsupported.

## Upgrade policy

Patch upgrades within a tested component line require `pnpm verify`, container
smoke, and recovery E2E. A Langfuse major version, PostgreSQL major version,
ClickHouse minor version, manifest major version, or storage-layout change
requires a new compatibility fixture and explicit recovery evidence.
