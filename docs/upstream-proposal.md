# Upstream Proposal

## Summary

Propose `langfuse-backup` as an independent, optional open-source recovery tool
for self-hosted Langfuse. It coordinates the existing native backup mechanisms
for PostgreSQL, ClickHouse, Redis/BullMQ consistency, and blob storage, then
writes one verifiable manifest as the recovery-point commit marker.

The tool remains outside the Langfuse web and worker processes. A broken or
unavailable Langfuse application must not prevent operators from listing,
verifying, or restoring recovery points.

## Upstream need

The official
[backup strategy guide](https://langfuse.com/self-hosting/configuration/backups)
documents separate PostgreSQL, ClickHouse, and storage procedures. Langfuse
[discussion #5421](https://github.com/orgs/langfuse/discussions/5421) reports a
real migration where traces appeared in lists but detail reads failed after
independent database restore. That is the failure class this project targets:
component backups can each succeed without creating a usable cross-component
recovery point.

The proposal also treats
[the announced v4 architecture changes](https://github.com/orgs/langfuse/discussions/12518)
as a compatibility boundary. New major storage contracts require explicit
fixtures and recovery evidence rather than assumed v3 compatibility.

## Package boundary

`langfuse-backup` owns:

- Configuration and secret references.
- Destination locks, staging state, receipts, and the final manifest.
- Coordinated ingestion hooks and BullMQ queue-drain checks.
- Native `pg_dump`/`pg_restore` and ClickHouse `BACKUP`/`RESTORE` orchestration.
- Exact blob inventories or verified S3-compatible copies.
- Read-only restore planning, empty-target checks, dirty journals, and reports.
- Scheduled backup-destroy-restore verification.

Langfuse continues to own application schemas, migrations, queue definitions,
deployment documentation, and public API behavior. Provider-native tools remain
the data formats; this project does not introduce a proprietary archive.

## Current evidence

The isolated recovery E2E uses different source and target Compose projects,
networks, volumes, credentials, ports, and deployment IDs. It:

1. Seeds representative identity, project, prompt, dataset, trace, observation,
   score, raw-event, and media records.
2. Commits a manifest only after PostgreSQL, ClickHouse, and blob receipts verify.
3. Deletes source containers and volumes.
4. Restores an empty target and reads PostgreSQL, ClickHouse, blobs, and an HTTP
   API fixture.

This proves the component orchestration and destructive recovery sequence. It
does not yet prove an end-to-end restore of a released Langfuse application
image and its complete migration schema. The compatibility matrix labels that
gap; public stable-release claims should remain blocked until that test exists.

## Security model

Secrets are environment or mounted-file references, never manifest values.
ClickHouse uses named collections so HMAC values do not enter SQL logs. Provider
and native-process errors pass through central redaction. Restore rejects the
source deployment, non-empty targets, missing secret references, incompatible
versions, and unexpected backup IDs before writes.

See [the threat model](security/threat-model.md) and
[credential matrix](security/credential-matrix.md).

## Proposed upstream path

1. Ask maintainers to review the component boundary and v3/v4 compatibility
   contract, not to adopt or endorse the package immediately.
2. Add a released-Langfuse source/API seed and target/API validation fixture.
3. Run recovery evidence against versions selected by upstream maintainers.
4. Decide whether documentation should link to the tool as a community option.
5. Discuss ownership, security response, and release responsibility before any
   namespace or repository transfer.

This proposal does not request the `@langfuse` npm scope, Langfuse trademarks,
repository transfer, or maintainer endorsement.
