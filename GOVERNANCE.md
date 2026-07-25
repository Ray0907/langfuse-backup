# Governance

`langfuse-backup` is currently maintained by the repository owner. Maintainers
review contributions, triage releases, and protect the recovery and security
contracts.

## Decision making

Routine changes use pull-request consensus. The maintainer records material
decisions in architecture, compatibility, security, or release documentation.
When consensus is not possible, the maintainer makes the final decision and
documents the tradeoff.

The following changes require explicit maintainer approval:

- Manifest or receipt compatibility.
- Destructive restore behavior and target checks.
- Credential, hook, or provider trust boundaries.
- Release credentials, signing, provenance, or package ownership.
- Project namespace, trademark, or upstream ownership claims.

## Releases and ownership

One protected source commit must produce the npm and OCI artifacts. Release
automation requires verification, container smoke, isolated recovery, security,
and artifact checks.

This project does not claim the `@langfuse` npm scope, Langfuse trademarks, or
upstream endorsement. Ownership or namespace changes require written agreement
with upstream maintainers and an update to this document.

Additional maintainers may be added after sustained reviewed contributions and
demonstrated care with destructive and security-sensitive code. Removal follows
inactivity, unresolvable conflict of interest, or a serious policy violation.
