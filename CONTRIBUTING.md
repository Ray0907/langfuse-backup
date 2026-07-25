# Contributing

Thank you for improving `langfuse-backup`. Changes should preserve the core
recovery contract: a recovery point is valid only after its final manifest is
written, and restore only targets a separate empty deployment.

## Development setup

Use Node.js 24, pnpm 11, and a running Docker daemon with Compose.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm verify
```

Run the OCI smoke test for container or dependency changes:

```bash
docker build -t langfuse-backup:test .
bash test/container/smoke.sh langfuse-backup:test
```

Run the isolated recovery test for backup, consistency, manifest, provider, or
restore changes:

```bash
bash scripts/run-recovery-e2e.sh
```

The recovery test creates unique Compose projects and deletes only those
temporary projects and volumes.

## Pull requests

- Add tests that fail before the behavior change and pass afterward.
- Keep provider credentials, database URLs, signed URLs, tokens, and real
  customer data out of source, fixtures, logs, issues, and commits.
- Describe compatibility effects when changing a manifest schema, receipt,
  backup path, or restore order.
- Preserve backward parsing for supported manifest versions or include an
  explicit migration and compatibility note.
- Update `CHANGELOG.md` for user-visible changes.
- Keep changes narrowly scoped and include the commands used for verification.

Do not publish packages, images, tags, or release artifacts from a contributor
branch.

## Commit and review expectations

Commits should be focused and reviewable. Security, credential handling,
destructive restore behavior, and manifest compatibility require maintainer
review. A passing CI run does not replace review of those boundaries.
