# Progress

Last updated: 2026-07-24

## Current State

Status: Planning

The OSS architecture and phased implementation plans are being established.
No runtime package code exists yet.

## Milestones

| Milestone | Status | Exit evidence |
| --- | --- | --- |
| M0 Project bootstrap | Planned | CLI help, CI, lint, typecheck, unit test pass |
| M1 Backup foundation | Planned | PostgreSQL and ClickHouse backup receipts pass |
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

1. Review and approve the architecture and phase boundaries.
2. Execute the project-bootstrap plan.
3. Keep this file updated after every implementation loop.

## Loop Run

- Contract: Current request; complete OSS plans and progress record; run
  `node scripts/verify-plans.mjs`; only new planning-folder files, maximum 3 rounds.
- Round 1: Target path was available and Langfuse backup research already existed;
  generated architecture, five implementation plans, progress ledger, and verifier;
  `Plan verification passed: 8 Markdown files, 0 broken links, 0 format errors.`;
  Correct; stop.
- Stop: pass; Required artifacts and fixed verification are complete; implementation
  and recovery behavior remain unproven until their plans are executed.
