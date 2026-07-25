## Summary

Describe the recovery problem and the narrow change.

## Compatibility and safety

- [ ] I documented manifest or receipt compatibility effects, or none exist.
- [ ] I did not add real credentials, signed URLs, backup contents, or customer data.
- [ ] Restore remains explicit and targets a separate empty deployment.
- [ ] I updated user-facing and security documentation when applicable.

## Verification

- [ ] `pnpm verify`
- [ ] Container smoke test when container or dependencies changed.
- [ ] `bash scripts/run-recovery-e2e.sh` when backup or restore behavior changed.

Paste concise, redacted results:
