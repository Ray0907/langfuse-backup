# Threat Model

## Scope and assets

`langfuse-backup` runs outside the Langfuse web and worker processes. It can
read production PostgreSQL, ClickHouse, Redis queue state, and blob storage,
and can write a recovery destination. Restore credentials can write to a
separate target.

Protected assets are database and object contents, provider credentials,
backup integrity, deployment identity, recovery availability, and evidence
that a recovery point is complete.

## Trust boundaries

```text
operator/CI
  | configuration, secret references, hooks
  v
langfuse-backup process
  | native clients and provider SDKs
  +--> production data services (read)
  +--> recovery destination (write/read)
  `--> isolated restore target (write)
```

Provider APIs, native client stderr, hook output, backup objects, configuration
files, and restore targets are untrusted inputs. A committed manifest is trusted
only after schema, component receipt, size, and checksum validation.

## Threats and controls

### Credential leakage

Credentials can escape through SQL, process arguments, provider errors, URLs,
headers, logs, manifests, and CI artifacts. Configuration accepts only
environment or mounted-file references. ClickHouse production SQL uses a named
collection. Central redaction covers structured keys, authenticated URLs,
authorization headers, signed query parameters, command flags, access-key IDs,
and private-key blocks. Manifest serialization rejects secret-bearing fields
and values. CI failure artifacts must contain redacted logs only.

Residual risk: an arbitrary hook can print data outside this process. Operators
must keep hook output out of shared logs and use a dedicated identity.

### Malicious backup objects and path traversal

An attacker with destination write access may substitute a dump, inventory, or
blob, or use object names as filesystem paths. Restore verifies receipt sizes
and checksums before native clients run. Temporary files use private directories
and fixed filenames. Filesystem test destinations reject paths outside their
root. Target object keys are treated as provider keys, not local paths.

Residual risk: native PostgreSQL and ClickHouse parsers process attacker-controlled
artifacts after integrity validation. Recovery destination writers therefore
remain highly trusted.

### Destination lock takeover

Two writers could create inconsistent staging data or an attacker could remove
a live lock. Locks use generation preconditions, identify the owning backup,
and require an explicit expired-lock takeover. Manifest creation remains the
only commit marker, so abandoned staging data is never listed as recoverable.

### Restore into the wrong environment

A credential or configuration error could overwrite production. Planning rejects
matching source and target deployment IDs, non-empty targets, missing secrets,
incompatible versions, and missing artifacts before writes. Execution requires
`--target`, `--confirm`, and an exact `--expected-backup-id`. A target lock and
dirty journal prevent a different backup from resuming partial work.

Residual risk: deployment IDs are operator assertions. Separate credentials,
networks, projects, and administrative approval remain required.

### Artifact substitution and checksum downgrade

An attacker may replace an object while keeping its path or provide a weak
checksum. PostgreSQL and copied blobs use SHA-256 receipts. GCS inventories bind
provider generations and native checksums. The final canonical manifest has a
SHA-256 recorded as destination metadata and is written with create-only
preconditions. Unsupported manifest major versions fail closed.

### Compromised provider credentials

Source credentials should be read-only. Destination credentials should be
restricted to one backup prefix and must not administer production. Restore
credentials should exist only for the isolated target. Credential rotation and
provider audit logs are operator responsibilities. A compromised destination
writer can deny recovery and must be treated as a critical incident.

### Untrusted pre- and post-hooks

Hooks are arbitrary commands with the privileges of the backup process. They
can exfiltrate secrets, block ingestion indefinitely, or execute unintended
shell syntax. Commands default to direct argument execution, shell mode is
explicit, timeouts are mandatory, and the post-hook runs during cleanup.
Operators must use fixed executables, minimal permissions, and reviewed scripts.

## Verification

`test/security/no-secrets.test.ts` exercises structured logging, native process
stderr, provider failures, and manifest rejection. The recovery E2E proves that
the source is destroyed before the isolated target is accepted.
