# Releasing

Releases are produced from one protected tag by
`.github/workflows/release.yml`. The workflow publishes npm and GHCR artifacts
from the same commit, generates npm provenance and an SPDX document, asks
BuildKit for OCI provenance and SBOM attestations, and signs the image digest
with keyless Cosign.

The reproducibility gate builds the runtime image twice without provenance and
compares its image ID. Release provenance is generated separately because each
attestation intentionally records a distinct build event.

## One-time repository setup

Before creating any release tag:

1. Confirm ownership and availability of the unscoped `langfuse-backup` npm
   package. Do not use the `@langfuse` scope without written upstream agreement.
2. Configure npm trusted publishing for this repository and the `release`
   workflow. Do not create a long-lived npm token.
3. Create a protected GitHub `release` environment with required maintainer
   approval.
4. Protect the default branch and version tags. Require CI, reproducible build,
   recovery E2E, and review.
5. Enable GitHub Private Vulnerability Reporting.
6. Confirm GHCR package visibility, retention, and maintainer ownership.

The release remains blocked until all six checks are complete.

## Prepare a release candidate

Update `package.json` and `CHANGELOG.md` to the same pre-release version, for
example `0.1.0-rc.1`. Run:

```bash
pnpm install --frozen-lockfile
pnpm verify
bash scripts/run-recovery-e2e.sh
docker build \
  --build-arg SOURCE_REVISION="$(git rev-parse HEAD)" \
  --build-arg TOOL_VERSION="0.1.0-rc.1" \
  -t langfuse-backup:release .
bash test/container/smoke.sh langfuse-backup:release
ARTIFACT_IMAGE=langfuse-backup:release pnpm verify:artifact
```

Review the SPDX file under `.artifacts/`, the recovery output, dependency audit,
and exact compatibility claims. The worktree must be clean before tagging.

Create a signed tag only after approval:

```bash
git tag -s v0.1.0-rc.1 -m "langfuse-backup 0.1.0-rc.1"
git push origin v0.1.0-rc.1
```

Pushing is an external write and must be a deliberate maintainer action. An RC
publishes to npm dist-tag `next`, never `latest`.

## Verify published artifacts

The workflow installs the published package in a clean temporary directory,
pulls the image by digest, runs its container smoke test, and creates a
pre-release with the package archive and SPDX document. Verify keyless signing:

```bash
cosign verify \
  --certificate-identity-regexp='^https://github.com/.+/.github/workflows/release.yml@' \
  --certificate-oidc-issuer=https://token.actions.githubusercontent.com \
  ghcr.io/ray0907/langfuse-backup@sha256:DIGEST
```

Run the documented recovery E2E once more against the tagged source before
promoting the version. A stable tag without a hyphen publishes npm dist-tag
`latest`.

## Failure and rollback

Never overwrite an npm version, image digest, or Git tag. If publication is
partial, stop the workflow, record which immutable artifacts exist, mark the
GitHub release as failed, and publish a new patch or RC version after correction.
Revoke or rotate credentials if logs or provider output may have exposed them.
