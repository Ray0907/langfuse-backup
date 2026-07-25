# Security Policy

## Supported versions

Before the first stable release, only the latest pre-release commit is
supported. After release, the latest minor release receives security fixes.
Older versions may be asked to upgrade before a fix is backported.

## Report a vulnerability privately

Use the repository Security tab and select **Report a vulnerability**. This
opens a private GitHub Security Advisory visible only to repository maintainers.

Do not open a public issue for:

- Exposed credentials, signed URLs, tokens, or backup encryption material.
- A restore that can write to the source or an unintended deployment.
- Backup-object substitution, checksum bypass, or path traversal.
- Lock takeover, command injection, or unsafe hook execution.

Include the affected version or commit, deployment topology, minimal
reproduction, and impact. Replace all real credentials and customer data with
synthetic values.

Maintainers will acknowledge a complete report within seven days, provide
status at least every 14 days, and target coordinated disclosure within 90 days.
The timeline may change when a provider or upstream dependency must coordinate
a fix. Reporters will be credited unless they request otherwise.

## Security boundary

`langfuse-backup` handles highly privileged database and object-storage access.
Operators are responsible for least-privilege credentials, isolated restore
targets, protected CI environments, and testing recovery before relying on a
backup policy. See [the threat model](docs/security/threat-model.md).
