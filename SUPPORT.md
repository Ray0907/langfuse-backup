# Support

This project is community-supported and provided without a service-level
agreement.

Use GitHub Discussions for usage questions and the issue templates for
reproducible bugs or focused feature requests. Include the package version,
deployment topology, provider, redacted configuration shape, and verification
output.

Never include database URLs, access keys, signed URLs, tokens, private keys,
backup contents, or customer data. Suspected security issues belong in a
private vulnerability report as described in [SECURITY.md](SECURITY.md).

The initial compatibility target is Docker Compose with PostgreSQL 17,
ClickHouse native backup, Redis/BullMQ queue inspection, GCS recovery storage,
and GCS or S3-compatible blob storage. See
[the compatibility matrix](docs/compatibility.md) before reporting an
unsupported topology.
