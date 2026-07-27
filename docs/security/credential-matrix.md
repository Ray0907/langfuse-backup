# Credential Matrix

All values are supplied by environment-variable or mounted-file references.
Secret values never belong in YAML, manifests, command examples, issue reports,
or CI artifacts.

| Credential | Used by | Minimum source scope | Restore scope | Stored in manifest |
| --- | --- | --- | --- | --- |
| PostgreSQL URL | `pg_dump`, `psql`, `pg_restore` | Read all Langfuse schemas | Create objects and write target DB | Reference name only |
| ClickHouse HTTP auth | Preflight and status polling | Read metadata, execute backup | Execute restore on target | No |
| ClickHouse S3 HMAC | Named collection in ClickHouse | Write one recovery prefix | Read same prefix | Reference name only |
| Redis URL | BullMQ queue inspector | Read queue counts | Not used | No |
| GCS destination identity | Destination adapter | Create/read/list/delete configured prefix | Read recovery artifacts | Workload identity or reference only |
| GCS blob identity | Inventory adapter | List/read required source prefixes and generations | Write isolated target bucket | No |
| S3/MinIO source key | Blob copy adapter | List/read required prefixes | Not reused | No |
| S3/MinIO target key | Blob restore adapter | Not used | Write/read isolated target prefixes | No |
| Release OIDC token | GitHub Actions | Not used at runtime | Not used at runtime | No |

## Separation requirements

- Production read, recovery destination, and restore target use different
  identities.
- A recovery destination identity cannot administer production databases.
- Restore credentials cannot resolve or write the source deployment.
- ClickHouse HMAC values remain in a named collection or environment-backed
  server configuration, never inline in backup SQL.
- Release publishing uses short-lived OIDC in a protected GitHub environment;
  no long-lived npm, registry, or signing key is committed.

## Rotation

Rotate a credential immediately after suspected exposure. Test access with
`doctor`, create a new recovery point when source or destination credentials
change, and retain old credentials only as long as needed to read retained
recovery points. Record the reference-name change in compatibility and operator
runbooks without recording secret values.
