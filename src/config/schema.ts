import { z } from "zod";

const IdentifierSchema = z.string().trim().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);

export const SecretReferenceSchema = z.union(
	[
		z.object({ env: z.string().trim().min(1) }).strict(),
		z.object({ file: z.string().trim().min(1) }).strict(),
	],
	{ error: "Expected a secret reference with env or file" },
);

const HookSchema = z.object({
	command: z.array(z.string().min(1)).min(1),
	timeout_ms: z.number().int().positive().default(30_000),
	shell: z.boolean().default(false),
}).strict();

const ConfigSchemaInternal = z.object({
	deployment_id: IdentifierSchema,
	consistency: z.object({
		mode: z.enum(["coordinated", "online"]).default("coordinated"),
		pre_hook: HookSchema.optional(),
		post_hook: HookSchema.optional(),
		queue_drain_timeout_ms: z.number().int().positive().default(300_000),
	}).strict(),
	destination: z.object({
		provider: z.literal("gcs"),
		bucket: z.string().trim().min(1),
		prefix: z.string().trim().default("langfuse-backups"),
		credentials: SecretReferenceSchema.optional(),
	}).strict(),
	postgres: z.object({
		url: SecretReferenceSchema,
		pg_dump_path: z.string().trim().default("pg_dump"),
		pg_restore_path: z.string().trim().default("pg_restore"),
	}).strict(),
	clickhouse: z.object({
		endpoint: z.string().url(),
		database: IdentifierSchema.default("default"),
		named_collection: IdentifierSchema.optional(),
		hmac_access_key: SecretReferenceSchema.optional(),
		hmac_secret_key: SecretReferenceSchema.optional(),
	}).strict().refine(
		(value_clickhouse) => value_clickhouse.named_collection !== undefined
			|| (value_clickhouse.hmac_access_key !== undefined
				&& value_clickhouse.hmac_secret_key !== undefined),
		"ClickHouse requires a named collection or both HMAC secret references",
	),
	redis: z.object({
		url: SecretReferenceSchema,
		shards: z.array(z.string().trim().min(1)).default([]),
	}).strict(),
	blob: z.discriminatedUnion("provider", [
		z.object({
			provider: z.literal("gcs"),
			bucket: z.string().trim().min(1),
			prefixes: z.array(z.string().trim().min(1)).default(["events/", "media/"]),
			immutable_bucket: z.boolean().default(false),
		}).strict(),
		z.object({
			provider: z.literal("s3"),
			bucket: z.string().trim().min(1),
			endpoint: z.string().url(),
			region: z.string().trim().min(1).default("us-east-1"),
			access_key: SecretReferenceSchema,
			secret_key: SecretReferenceSchema,
			prefixes: z.array(z.string().trim().min(1)).default(["events/", "media/"]),
		}).strict(),
	]),
}).strict();

export const ConfigSchema = ConfigSchemaInternal.readonly();
export type BackupConfig = z.infer<typeof ConfigSchema>;
