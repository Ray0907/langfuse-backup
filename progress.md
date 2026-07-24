# Progress

Last updated: 2026-07-24

## Current State

Status: Implementing M2

Project bootstrap is complete. The repository now has a tested CLI, validated
configuration contracts, centralized redaction, a non-root OCI image with
PostgreSQL 17 clients, and pinned continuous-integration gates.

## Milestones

| Milestone | Status | Exit evidence |
| --- | --- | --- |
| M0 Project bootstrap | Complete | `pnpm verify`, image build, smoke test pass |
| M1 Backup foundation | Complete | 51 tests and `pnpm verify` pass |
| M2 Coordinated recovery point | Planned | Queue drain and blob backup integration pass |
| M3 Restore validation | Planned | Isolated backup-destroy-restore-verify passes |
| M4 OSS release | Planned | Signed npm and OCI release plus public docs |

## Decisions

| Date | Decision | Reason |
| --- | --- | --- |
| 2026-07-24 | Start with Docker Compose | Smallest self-hosted deployment boundary |
| 2026-07-24 | Use GCS as first destination | Initial user requirement |
| 2026-07-24 | Build a standalone CLI and OCI image | Recovery must not depend on Langfuse health |
| 2026-07-24 | Reuse native database backups | Avoid a custom backup format |
| 2026-07-24 | Require a final manifest | Distinguish valid recovery points from partial runs |

## Risks

- Cross-component consistency depends on successfully blocking new ingestion.
- GCS-backed ClickHouse backup requires its S3-compatible interface and HMAC.
- Blob inventory can be expensive for large buckets.
- Restore safety requires an empty, isolated target and strict version checks.
- Publishing under an `@langfuse` scope requires upstream maintainer approval.

## Next Actions

1. Execute the consistency and blob-storage plan.
2. Keep this file updated after every verified milestone.

## Loop Run

- Contract: Current request; complete OSS plans and progress record; run
  `node scripts/verify-plans.mjs`; only new planning-folder files, maximum 3 rounds.
- Round 1: Target path was available and Langfuse backup research already existed;
  generated architecture, five implementation plans, progress ledger, and verifier;
  `Plan verification passed: 8 Markdown files, 0 broken links, 0 format errors.`;
  Correct; stop.
- Stop: pass; Required artifacts and fixed verification are complete; implementation
  and recovery behavior remain unproven until their plans are executed.

## Loop Run: Bootstrap Batch 1

- Contract: Implementation request; complete bootstrap Tasks 1–3, maximum 5 rounds;
  run `pnpm verify`; directly related local files and no external writes.
- Round 1: Node 24.18.0 and pnpm 11.0.0 were available; added repository metadata,
  CLI skeleton, configuration, and logging contracts; config RED exposed shallow
  freezing and lint RED exposed missing Node globals; fixed both root causes;
  `pnpm verify` passed 3 test files and 7 tests; Correct; continue with Tasks 4–5.
- Stop: pass; The first three-task batch is verified; M0 remains incomplete until
  the OCI image and CI checks pass.

## Loop Run: Bootstrap Batch 2

- Contract: Implementation request; complete bootstrap Tasks 4–5, maximum 5 rounds;
  run `pnpm verify`, image build, and container smoke; directly related local files.
- Round 1: Added a PostgreSQL 17 and Node 24 multi-stage image, non-root smoke test,
  SHA-pinned CI, and dependency updates; 7 tests, image build, and smoke passed;
  Correct; continue with M1.
- Stop: pass; M0 exit criteria are verified; release-time digest pinning remains M4.

## Loop Run: Backup Foundation

- Contract: Implementation request; complete M1, maximum 5 rounds; run `pnpm verify`;
  local package files only and no external writes.
- Round 1: Added manifest compatibility, GCS locking/staging, PostgreSQL custom dumps,
  ClickHouse native backup polling, and manifest-last orchestration; full gate first
  found a BullMQ reader type mismatch from concurrent M2 work; narrowed it to
  `JobType`; `pnpm verify` passed 17 test files and 51 tests; Correct; continue M2.
- Stop: pass; M1 receipts, failure paths, and commit marker are verified; live cloud
  and database recovery remains covered by the later isolated recovery E2E.
