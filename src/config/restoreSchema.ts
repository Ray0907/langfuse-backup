import { readFile } from "node:fs/promises";

import { parse } from "yaml";
import { z } from "zod";

import { SecretReferenceSchema } from "./schema.js";

const IdentifierSchema = z.string().trim().min(1).max(128)
	.regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);

const HookSchema = z.object({
	command: z.array(z.string().min(1)).min(1),
	timeout_ms: z.number().int().positive().default(30_000),
	shell: z.boolean().default(false),
}).strict();

export const RestoreTargetConfigSchema = z.object({
	deployment_id: IdentifierSchema,
	langfuse_version: z.string().trim().min(1),
	secret_references: z.array(z.string().trim().min(1)).default([]),
	postgres: z.object({
		url: SecretReferenceSchema,
		pg_restore_path: z.string().trim().default("pg_restore"),
		psql_path: z.string().trim().default("psql"),
	}).strict(),
	clickhouse: z.object({
		endpoint: z.string().url(),
		database: IdentifierSchema.default("default"),
		named_collection: IdentifierSchema,
		username: SecretReferenceSchema.optional(),
		password: SecretReferenceSchema.optional(),
	}).strict(),
	blob: z.object({
		provider: z.literal("gcs"),
		bucket: z.string().trim().min(1),
		prefix: z.string().trim().default(""),
		credentials: SecretReferenceSchema.optional(),
	}).strict(),
	health_checks: z.array(HookSchema).default([]),
	smoke_test: HookSchema,
}).strict().readonly();

export type RestoreTargetConfig = z.infer<typeof RestoreTargetConfigSchema>;

export async function loadRestoreTargetConfig(
	path_config: string,
): Promise<RestoreTargetConfig> {
	const value_config: unknown = parse(await readFile(path_config, "utf8"));
	const result_config = RestoreTargetConfigSchema.safeParse(value_config);
	if (!result_config.success) {
		const details_error = result_config.error.issues
			.map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
			.join("; ");
		throw new Error(`Invalid restore target configuration: ${details_error}`);
	}
	return result_config.data;
}
