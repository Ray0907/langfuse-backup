# Progress

Last updated: 2026-07-27

## Current State

Status: Public repository published; source release candidate verified

The repository now has a tested backup and restore CLI, validated configuration
contracts, centralized redaction, a reproducible non-root OCI image, PostgreSQL 17
clients, pinned continuous-integration gates, and public-ready documentation.

## Milestones

| Milestone | Status | Exit evidence |
| --- | --- | --- |
| M0 Project bootstrap | Complete | `pnpm verify`, image build, smoke test pass |
| M1 Backup foundation | Complete | 51 tests and `pnpm verify` pass |
| M2 Coordinated recovery point | Complete | 74 tests and `pnpm verify` pass |
| M3 Restore validation | Complete | 113 tests plus isolated recovery E2E pass |
| M4 OSS release automation | Complete | 139 tests, reproducible artifacts and docs |

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
- A live GCP integration run and full released-Langfuse-image recovery remain pending.
- npm, GHCR, tags, and GitHub Releases remain unpublished until maintainers configure
  the protected release environment and trusted publishing.

## Next Actions

1. Require hosted CI and reproducibility checks for changes to `main`.
2. Do not create a release tag until the protected release environment and trusted
   publishing identities are configured.

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

## Loop Run: Coordinated Recovery Point

- Contract: Implementation request; complete M2, maximum 5 rounds; run `pnpm verify`;
  local package files and isolated test containers only.
- Round 1: Added BullMQ queue inspection, fail-closed hooks/drain, streaming GCS
  inventory, resumable S3-compatible copy, coordinated manifest boundaries, and
  retention planning; dependency install exposed an unreviewed optional build script,
  so it was explicitly denied after confirming the JavaScript fallback;
  `pnpm verify` passed 26 files and 74 tests;
  Correct; continue M3.
- Stop: pass; coordinated ordering, receipts, and failure cleanup are verified;
  containerized backup-destroy-restore evidence remains the M3 gate.

## Loop Run: Restore Validation

- Contract: Implementation request; complete M3, maximum 5 rounds; run `pnpm verify`
  and `bash scripts/run-recovery-e2e.sh`; local package files and isolated test
  containers only.
- Round 1: Added read-only planning, resumable blob restore, native PostgreSQL and
  ClickHouse restore, explicit restore orchestration, and isolated source/target
  Compose fixtures; a safety test exposed a lock leak on initial journal failure
  and the live ClickHouse 26 API exposed server-assigned async operation IDs; fixed
  both root causes; `pnpm verify` passed 34 files and 113 tests, and the recovery E2E
  passed after destroying source containers and volumes; Correct; continue M4.
- Stop: pass; M3 proves manifest-last backup, destructive source teardown, target
  restore, component reads, and an HTTP API smoke read; external publication remains
  outside the authorized implementation scope.

## Loop Run: OSS Release and Public CLI

- Contract: Current implementation and publication request; finish M4 and the public
  CLI, maximum 5 rounds; run `pnpm verify`, plan verification, OCI build and smoke,
  isolated recovery E2E, and artifact verification; local repository and isolated
  containers are in budget, and a public GitHub source push is authorized; package,
  registry, release-tag, and live-cloud publication require separate authorization.
- Round 1: Replaced CLI placeholders with backup, verification, retention, restore,
  and doctor runtime wiring; full verification exposed build-time version constants
  that were unavailable to direct test imports; added safe source fallbacks;
  Incorrect; continue.
- Round 2: A stale image first hid the new CLI, then review found backup-specific
  target locks, a late PostgreSQL client check, retention unaware of active restores,
  missing blob preflight, and nondeterministic dependency metadata; made the restore
  lock and journal target-global, moved compatibility checks before writes, retained
  active recovery points, added provider preflight, and normalized the runtime layer;
  two clean OCI builds then produced the same image ID; Incorrect until the fixed
  end-to-end gate reran.
- Round 3: The fixed gate passed 38 test files and 135 tests, plan verification,
  container smoke, destructive source-to-target recovery, and artifact verification
  with a 139-package SPDX inventory; Correct; source verification is complete.
- Stop: pass; all local implementation and release-candidate gates are complete;
  the remaining authorized action is the public source push and hosted CI check.
