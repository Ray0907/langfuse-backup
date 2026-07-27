import { readFile } from "node:fs/promises";

import { S3Client } from "@aws-sdk/client-s3";

import { createHttpClickhouseQuery, getClickhouseVersion } from
	"../adapters/clickhouse/clickhouseDoctor.js";
import { createClickhouseBackup } from "../adapters/clickhouse/clickhouseBackup.js";
import { createPostgresBackup } from "../adapters/postgres/postgresBackup.js";
import { getPostgresVersions } from "../adapters/postgres/postgresDoctor.js";
import { inspectRedisQueues } from "../adapters/redis/queueInspector.js";
import { getIngestionQueueNames } from "../adapters/redis/queueNames.js";
import { copyBlobPrefixes } from "../blob/copyBlobPrefix.js";
import { writeGcsInventory } from "../blob/gcsInventory.js";
import { createS3ObjectSource } from "../blob/s3Source.js";
import { inspectRecoveryPoint } from "../commands/inspect.js";
import { listRecoveryPoints } from "../commands/list.js";
import { runPrune } from "../commands/prune.js";
import { verifyRecoveryPoint } from "../commands/verify.js";
import { loadConfig } from "../config/loadConfig.js";
import type { BackupConfig, SecretReference } from "../config/schema.js";
import type { BackupDestination } from "../destination/types.js";
import { createLogger, type Logger } from "../logging/logger.js";
import { createBackup } from "../orchestration/createBackup.js";
import { runHook } from "../orchestration/runHook.js";
import { revision_source, version_tool } from "../version.js";
import {
	createGcsInventorySource,
	createRuntimeGcsBucket,
	createRuntimeGcsDestination,
	type RuntimeGcsDestination,
} from "./gcs.js";
import { getSecretReferenceName, resolveSecret } from "./secret.js";

export interface CreateRuntimeOptions {
	path_config: string;
	backup_id?: string;
	allow_active_writes: boolean;
	allow_container_hooks: boolean;
	takeover_expired_lock: boolean;
}

export interface PruneRuntimeOptions {
	path_config: string;
	keep_daily: number;
	keep_weekly: number;
	confirm: boolean;
}

interface RuntimeContext {
	config: BackupConfig;
	destination: RuntimeGcsDestination;
	logger: Logger;
}

function createBackupId(now: Date = new Date()): string {
	return now.toISOString().replace(/[-:.]/g, "").replace("T", "-").replace("Z", "Z");
}

export function assertBackupId(backup_id: string): void {
	if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(backup_id)) {
		throw new Error(
			"Backup ID must use 1-128 ASCII letters, digits, underscores, or hyphens",
		);
	}
}

function getQueueNames(config: BackupConfig): string[] {
	return config.redis.shards.length > 0
		? [...config.redis.shards]
		: getIngestionQueueNames({
			ingestion: 1,
			secondary_ingestion: 1,
			otel_ingestion: 1,
			secondary_otel_ingestion: 1,
		});
}

async function createRuntimeContext(
	path_config: string,
	logger: Logger = createLogger(),
): Promise<RuntimeContext> {
	const config = await loadConfig(path_config);
	return {
		config,
		destination: await createRuntimeGcsDestination(config.destination),
		logger,
	};
}

async function createClickhouseQuery(config: BackupConfig) {
	const username = config.clickhouse.username === undefined
		? undefined
		: await resolveSecret(config.clickhouse.username);
	const password = config.clickhouse.password === undefined
		? undefined
		: await resolveSecret(config.clickhouse.password);
	return createHttpClickhouseQuery({
		endpoint: config.clickhouse.endpoint,
		...(username === undefined ? {} : { username }),
		...(password === undefined ? {} : { password }),
	});
}

async function createBlobS3Client(config: Extract<
	BackupConfig["blob"],
	{ provider: "s3" }
>): Promise<S3Client> {
	return new S3Client({
		endpoint: config.endpoint,
		region: config.region,
		forcePathStyle: true,
		credentials: {
			accessKeyId: await resolveSecret(config.access_key),
			secretAccessKey: await resolveSecret(config.secret_key),
		},
	});
}

async function getBlobDoctorEvidence(config: BackupConfig) {
	if (config.blob.provider === "gcs") {
		const bucket_source = await createRuntimeGcsBucket(
			config.blob.bucket,
			config.blob.credentials,
		);
		const source_inventory = createGcsInventorySource(bucket_source);
		const versioning_enabled = await source_inventory.isVersioningEnabled();
		if (!versioning_enabled && !config.blob.immutable_bucket) {
			throw new Error(
				"GCS source blob versioning is required without immutable_bucket",
			);
		}
		await Promise.all(config.blob.prefixes.map(async (prefix_object) =>
			source_inventory.getPage?.({
				prefix: prefix_object,
				page_size: 1,
			})));
		return {
			provider: "gcs",
			versioning_enabled,
			prefixes_checked: config.blob.prefixes.length,
		};
	}
	const client_s3 = await createBlobS3Client(config.blob);
	try {
		const source_s3 = createS3ObjectSource(client_s3, config.blob.bucket);
		await Promise.all(config.blob.prefixes.map(async (prefix_object) =>
			source_s3.listPage({ prefix: prefix_object })));
		return {
			provider: "s3",
			prefixes_checked: config.blob.prefixes.length,
		};
	} finally {
		client_s3.destroy();
	}
}

async function getDoctorEvidence(context: RuntimeContext) {
	const database_url = await resolveSecret(context.config.postgres.url);
	const redis_url = await resolveSecret(context.config.redis.url);
	const query_clickhouse = await createClickhouseQuery(context.config);
	const [versions_postgres, version_clickhouse, queues, objects_destination, blob] =
		await Promise.all([
			getPostgresVersions({
				database_url,
				pg_dump_path: context.config.postgres.pg_dump_path,
			}),
			getClickhouseVersion(query_clickhouse),
			inspectRedisQueues(redis_url, getQueueNames(context.config)),
			context.destination.destination.listObjects(""),
			getBlobDoctorEvidence(context.config),
		]);
	return {
		deployment_id: context.config.deployment_id,
		langfuse_version: context.config.langfuse_version,
		postgres: versions_postgres,
		clickhouse: { server_version: version_clickhouse },
		redis: {
			queue_count: queues.queues.length,
			pending_count: queues.pending_count,
			failed_count: queues.failed_count,
		},
		destination: {
			provider: "gcs",
			reachable: true,
			visible_object_count: objects_destination.length,
		},
		blob,
	};
}

function getRequiredSecrets(config: BackupConfig): string[] {
	const references_secret: SecretReference[] = [];
	if (config.clickhouse.hmac_access_key !== undefined) {
		references_secret.push(config.clickhouse.hmac_access_key);
	}
	if (config.clickhouse.hmac_secret_key !== undefined) {
		references_secret.push(config.clickhouse.hmac_secret_key);
	}
	if (config.blob.provider === "gcs" && config.blob.credentials !== undefined) {
		references_secret.push(config.blob.credentials);
	}
	return [...new Set(references_secret.map(getSecretReferenceName))].sort();
}

async function createBlobBackup(
	context: RuntimeContext,
	backup_id: string,
) {
	const prefix_backup = `deployments/${context.config.deployment_id}/backups/`
		+ `${backup_id}/staging`;
	const inventory_path = `${prefix_backup}/blob-inventory.ndjson.gz`;
	if (context.config.blob.provider === "gcs") {
		const bucket_source = await createRuntimeGcsBucket(
			context.config.blob.bucket,
			context.config.blob.credentials,
		);
		return writeGcsInventory({
			source: createGcsInventorySource(bucket_source),
			prefixes: context.config.blob.prefixes,
			immutable_bucket: context.config.blob.immutable_bucket,
			inventory_path,
			upload_file: context.destination.uploadFile,
		});
	}
	const client_s3 = await createBlobS3Client(context.config.blob);
	try {
		return await copyBlobPrefixes({
			source: createS3ObjectSource(client_s3, context.config.blob.bucket),
			prefixes: context.config.blob.prefixes,
			destination_prefix: `${prefix_backup}/blobs`,
			inventory_path,
			stat_object: context.destination.destination.statObject,
			upload_file: async (upload) => context.destination.uploadFile(
				upload.path_object,
				upload.path_file,
				upload.metadata,
			),
		});
	} finally {
		client_s3.destroy();
	}
}

async function runConfiguredHook(
	context: RuntimeContext,
	kind_hook: "pre_hook" | "post_hook",
	allow_container_hooks: boolean,
): Promise<void> {
	const hook = context.config.consistency[kind_hook];
	if (hook === undefined) {
		throw new Error(`Coordinated backup requires consistency.${kind_hook}`);
	}
	await runHook({
		command: hook.command,
		timeout_ms: hook.timeout_ms,
		shell: hook.shell,
		allow_container_hooks,
	});
}

export async function runDoctorRuntime(path_config: string) {
	return getDoctorEvidence(await createRuntimeContext(path_config));
}

export async function runCreateRuntime(options: CreateRuntimeOptions) {
	const context = await createRuntimeContext(options.path_config);
	const backup_id = options.backup_id ?? createBackupId();
	assertBackupId(backup_id);
	const database_url = await resolveSecret(context.config.postgres.url);
	const redis_url = await resolveSecret(context.config.redis.url);
	const query_clickhouse = await createClickhouseQuery(context.config);
	const named_collection = context.config.clickhouse.named_collection;
	if (named_collection === undefined) {
		throw new Error("CLI backups require a ClickHouse named collection");
	}
	return createBackup({
		destination: context.destination.destination,
		deployment_id: context.config.deployment_id,
		backup_id,
		langfuse_version: context.config.langfuse_version,
		consistency_mode: context.config.consistency.mode,
		allow_active_writes: options.allow_active_writes,
		preflight: async () => {
			await getDoctorEvidence(context);
		},
		run_pre_hook: async () => runConfiguredHook(
			context,
			"pre_hook",
			options.allow_container_hooks,
		),
		run_post_hook: async () => runConfiguredHook(
			context,
			"post_hook",
			options.allow_container_hooks,
		),
		inspect_queues: async () =>
			inspectRedisQueues(redis_url, getQueueNames(context.config)),
		queue_drain_timeout_ms: context.config.consistency.queue_drain_timeout_ms,
		backup_postgres: async () => createPostgresBackup({
			destination: context.destination.destination,
			deployment_id: context.config.deployment_id,
			backup_id,
			database_url,
			pg_dump_path: context.config.postgres.pg_dump_path,
			logger: context.logger,
		}),
		backup_clickhouse: async () => createClickhouseBackup({
			query: query_clickhouse,
			deployment_id: context.config.deployment_id,
			backup_id,
			database: context.config.clickhouse.database,
			named_collection,
		}),
		backup_blob: async () => createBlobBackup(context, backup_id),
		tool_version: version_tool,
		source_revision: revision_source,
		required_secrets: getRequiredSecrets(context.config),
		takeover_expired_lock: options.takeover_expired_lock,
		on_stage: (stage_backup) =>
			context.logger.info("Backup stage complete", { stage: stage_backup, backup_id }),
	});
}

export async function runListRuntime(path_config: string) {
	const context = await createRuntimeContext(path_config);
	return listRecoveryPoints(
		context.destination.destination,
		context.config.deployment_id,
	);
}

export async function runInspectRuntime(path_config: string, backup_id: string) {
	const context = await createRuntimeContext(path_config);
	return inspectRecoveryPoint(
		context.destination.destination,
		context.config.deployment_id,
		backup_id,
	);
}

export async function runVerifyRuntime(path_config: string, backup_id: string) {
	const context = await createRuntimeContext(path_config);
	return verifyRecoveryPoint(
		context.destination.destination,
		context.config.deployment_id,
		backup_id,
	);
}

async function deleteRecoveryPoint(
	destination: BackupDestination,
	deployment_id: string,
	backup_id: string,
): Promise<void> {
	const prefix_backup = `deployments/${encodeURIComponent(deployment_id)}/backups/`
		+ `${encodeURIComponent(backup_id)}/`;
	const objects_found = await destination.listObjects(prefix_backup);
	const objects_ordered = [...objects_found].sort((object_left, object_right) => {
		const left_manifest = object_left.path.endsWith("/manifest.json") ? 0 : 1;
		const right_manifest = object_right.path.endsWith("/manifest.json") ? 0 : 1;
		return left_manifest - right_manifest;
	});
	for (const object_found of objects_ordered) {
		await destination.deleteObject(object_found.path, object_found.generation);
	}
}

function getProviderErrorCode(error: unknown): number | undefined {
	if (error !== null && typeof error === "object" && "code" in error) {
		const code_error = Reflect.get(error, "code");
		return typeof code_error === "number" ? code_error : undefined;
	}
	return undefined;
}

async function getLockedBackupIds(
	destination: BackupDestination,
): Promise<Set<string>> {
	const objects_restore = await destination.listObjects("restores/");
	const ids_locked = new Set<string>();
	for (const object_restore of objects_restore) {
		if (!object_restore.path.endsWith("/lock.json")) {
			continue;
		}
		let data_lock: Buffer;
		try {
			data_lock = await destination.getObject(object_restore.path);
		} catch (error) {
			if (getProviderErrorCode(error) === 404) {
				continue;
			}
			throw error;
		}
		const value_lock = JSON.parse(data_lock.toString("utf8")) as unknown;
		if (value_lock === null || typeof value_lock !== "object"
			|| !("backup_id" in value_lock)
			|| typeof value_lock.backup_id !== "string") {
			throw new Error(`Invalid restore lock at ${object_restore.path}`);
		}
		ids_locked.add(value_lock.backup_id);
	}
	return ids_locked;
}

export async function runPruneRuntime(options: PruneRuntimeOptions) {
	const context = await createRuntimeContext(options.path_config);
	const [recovery_points, ids_locked] = await Promise.all([
		listRecoveryPoints(
			context.destination.destination,
			context.config.deployment_id,
		),
		getLockedBackupIds(context.destination.destination),
	]);
	return runPrune({
		points: recovery_points.map((point_recovery) => ({
			backup_id: point_recovery.manifest.backup_id,
			committed_at: point_recovery.manifest.committed_at,
			complete: true,
			locked: ids_locked.has(point_recovery.manifest.backup_id),
		})),
		policy: {
			keep_daily: options.keep_daily,
			keep_weekly: options.keep_weekly,
		},
		confirm: options.confirm,
		delete_recovery_point: async (backup_id) =>
			deleteRecoveryPoint(
				context.destination.destination,
				context.config.deployment_id,
				backup_id,
			),
	});
}

export async function readJsonFile(path_file: string): Promise<unknown> {
	return JSON.parse(await readFile(path_file, "utf8")) as unknown;
}
