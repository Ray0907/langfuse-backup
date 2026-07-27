# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Standalone TypeScript CLI and non-root PostgreSQL 17 OCI runtime.
- Validated YAML configuration with environment and mounted-file secret references.
- Canonical versioned manifests, final-manifest commit markers, locks, and receipts.
- Native PostgreSQL and ClickHouse backup and restore adapters.
- Coordinated ingestion hooks and BullMQ queue-drain enforcement.
- GCS generation inventories and resumable S3/MinIO-compatible blob copy.
- Retention planning that ignores incomplete staging prefixes.
- Read-only restore planning, explicit confirmation, target locks, and dirty journals.
- Isolated source-destroy-target-restore recovery E2E.
- Credential-boundary tests, threat model, governance, SPDX, provenance, and signing
  automation.

### Security

- Central redaction for authenticated URLs, authorization headers, command flags,
  signed provider query parameters, access-key IDs, and private-key blocks.
- Provider errors are redacted before crossing ClickHouse, GCS, S3, or native-process
  boundaries.
- The vulnerable transitive `uuid` line is overridden to 11.1.1.

### Known limitations

- No npm or GHCR artifact has been published.
- A released Langfuse application image and complete schema have not yet passed the
  recovery E2E; current evidence uses representative component records and an API
  fixture.
- Live GCP and live Redis/Valkey tests remain pending.

[Unreleased]: https://github.com/Ray0907/langfuse-backup/commits/main
