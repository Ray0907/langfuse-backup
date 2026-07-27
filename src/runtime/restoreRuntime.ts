import type { Bucket } from "@google-cloud/storage";

import { createHttpClickhouseQuery } from "../adapters/clickhouse/clickhouseDoctor.js";
import type { ClickhouseQuery } from "../adapters/clickhouse/queryBackupStatus.js";
import { inspectRecoveryPoint } from "../commands/inspect.js";
import { loadConfig } from "../config/loadConfig.js";
import {
	loadRestoreTargetConfig,
	type RestoreTargetConfig,
} from "../config/restoreSchema.js";
import type { BackupConfig, SecretReference } from "../config/schema.js";
import type {
	BackupDestination,
	DestinationObject,
} from "../destination/types.js";
import { restoreBlobStorage } from "../restore/restoreBlobStorage.js";
import type {
	BackupBlobReference,
	RestoreBlobJournalEntry,
} from "../restore/restoreBlobStorage.js";
import { restoreClickhouse } from "../restore/restoreClickhouse.js";
import { restorePostgres } from "../restore/restorePostgres.js";
import { createRestorePlan, type RestorePlan } from "../restore/restorePlan.js";
import {
	runRestore,
	type RestoreJournal,
	type RunRestoreResult,
} from "../restore/runRestore.js";
import { runHook } from "../orchestration/runHook.js";
import { runProcess } from "../process/runProcess.js";
import {
	createRuntimeGcsBucket,
	createRuntimeGcsDestination,
	hasGcsPrefix,
	readGcsGeneration,
	type RuntimeGcsDestination,
} from "./gcs.js";
import { getSecretReferenceName, resolveSecret } from "./secret.js";

export interface RestoreRuntimeOptions {
	path_config: string;
	path_target: string;
	expected_backup_id: string;
	confirm: boolean;
	accept_online_consistency: boolean;
	allow_container_hooks: boolean;
}

export interface RestorePlanRuntimeOptions {
	path_config: string;
	path_target: string;
	backup_id: string;
	accept_online_consistency: boolean;
}

interface RestoreConnectionOptions {
	path_config: string;
	path_target: string;
}

interface RestoreContext {
	source_config: BackupConfig;
	target_config: RestoreTargetConfig;
	recovery: RuntimeGcsDestination;
	target_blob: RuntimeGcsDestination;
	target_postgres_url: string;
	query_target: ClickhouseQuery;
	source_blob_bucket?: Bucket;
}

export interface RestoreRuntimePaths {
	lock: string;
	journal: string;
	blob_journal: string;
	report: string;
}

export function getRestoreRuntimePaths(
	target_deployment_id: string,
	backup_id: string,
): RestoreRuntimePaths {
	const prefix_target = `restores/${encodeURIComponent(target_deployment_id)}`;
	const prefix_backup = `${prefix_target}/backups/${encodeURIComponent(backup_id)}`;
	return {
		lock: `${prefix_target}/lock.json`,
		journal: `${prefix_target}/journal.json`,
		blob_journal: `${prefix_backup}/blob-journal.json`,
		report: `${prefix_backup}/report.json`,
	};
}

function quoteClickhouseString(value_string: string): string {
	return `'${value_string.replaceAll("\\", "\\\\").replaceAll("'", "''")}'`;
}

async function createTargetQuery(config: RestoreTargetConfig): Promise<ClickhouseQuery> {
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

async function createRestoreContext(
	options: RestoreConnectionOptions,
): Promise<RestoreContext> {
	const [source_config, target_config] = await Promise.all([
		loadConfig(options.path_config),
		loadRestoreTargetConfig(options.path_target),
	]);
	const [recovery, target_blob] = await Promise.all([
		createRuntimeGcsDestination(source_config.destination),
		createRuntimeGcsDestination({
			provider: "gcs",
			bucket: target_config.blob.bucket,
			prefix: target_config.blob.prefix,
			...(target_config.blob.credentials === undefined
				? {}
				: { credentials: target_config.blob.credentials }),
		}),
	]);
	const source_blob_bucket = source_config.blob.provider === "gcs"
		? await createRuntimeGcsBucket(
			source_config.blob.bucket,
			source_config.blob.credentials,
		)
		: undefined;
	return {
		source_config,
		target_config,
		recovery,
		target_blob,
		target_postgres_url: await resolveSecret(target_config.postgres.url),
		query_target: await createTargetQuery(target_config),
		...(source_blob_bucket === undefined ? {} : { source_blob_bucket }),
	};
}

async function runTargetPsql(
	context: RestoreContext,
	sql_query: string,
): Promise<string> {
	const result_query = await runProcess(context.target_config.postgres.psql_path, [
		"--dbname",
		context.target_postgres_url,
		"--tuples-only",
		"--no-align",
		"--command",
		sql_query,
	]);
	return result_query.stdout.trim();
}

async function isPostgresEmpty(context: RestoreContext): Promise<boolean> {
	const count_tables = await runTargetPsql(
		context,
		"SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname = 'public'",
	);
	return count_tables === "0";
}

async function isClickhouseEmpty(context: RestoreContext): Promise<boolean> {
	const result_count = await context.query_target(
		"SELECT count() AS count FROM system.tables WHERE database = "
		+ `${quoteClickhouseString(context.target_config.clickhouse.database)} FORMAT JSON`,
	);
	return Number(result_count.data[0]?.count ?? -1) === 0;
}

function getTargetSecretReferences(config: RestoreTargetConfig): string[] {
	const references_secret: SecretReference[] = [
		config.postgres.url,
		...(config.clickhouse.username === undefined ? [] : [config.clickhouse.username]),
		...(config.clickhouse.password === undefined ? [] : [config.clickhouse.password]),
		...(config.blob.credentials === undefined ? [] : [config.blob.credentials]),
	];
	return [...new Set([
		...config.secret_references,
		...references_secret.map(getSecretReferenceName),
	])].sort();
}

async function createPlan(
	context: RestoreContext,
	backup_id: string,
	accept_online_consistency: boolean,
): Promise<RestorePlan> {
	const recovery_point = await inspectRecoveryPoint(
		context.recovery.destination,
		context.source_config.deployment_id,
		backup_id,
	);
	const manifest = recovery_point.manifest;
	const [version_postgres, result_restore, result_clickhouse, blob_objects] =
		await Promise.all([
			runTargetPsql(context, "SHOW server_version"),
			runProcess(context.target_config.postgres.pg_restore_path, ["--version"]),
			context.query_target("SELECT version() AS version FORMAT JSON"),
			context.target_blob.destination.listObjects(""),
		]);
	const match_restore_version = result_restore.stdout.match(/\b(\d+(?:\.\d+)+)\b/);
	const version_restore = match_restore_version?.[1];
	if (version_restore === undefined
		|| version_restore.split(".")[0]
			!== manifest.components.postgres.client_version.split(".")[0]) {
		throw new Error(
			`pg_restore version is incompatible: ${version_restore ?? "unknown"} `
			+ `for dump client ${manifest.components.postgres.client_version}`,
		);
	}
	const version_clickhouse = result_clickhouse.data[0]?.version;
	if (typeof version_clickhouse !== "string" || version_clickhouse === "") {
		throw new Error("ClickHouse target version response is missing");
	}
	const clickhouse_valid = await hasGcsPrefix(
		context.recovery.bucket,
		manifest.components.clickhouse.object_prefix,
	);
	return createRestorePlan({
		manifest,
		target: {
			deployment_id: context.target_config.deployment_id,
			langfuse_version: context.target_config.langfuse_version,
			postgres_version: version_postgres,
			clickhouse_version: version_clickhouse,
			postgres_empty: await isPostgresEmpty(context),
			clickhouse_empty: await isClickhouseEmpty(context),
			blob_empty: blob_objects.length === 0,
			secret_references: getTargetSecretReferences(context.target_config),
		},
		artifacts: {
			postgres: await context.recovery.destination.statObject(
				manifest.components.postgres.object_path,
			),
			blob: await context.recovery.destination.statObject(
				manifest.components.blob.inventory_path,
			),
			clickhouse_valid,
		},
		accept_online_consistency,
		source_langfuse_version: manifest.langfuse_version
			?? context.source_config.langfuse_version,
	});
}

async function readJsonObject<T>(
	destination: BackupDestination,
	path_object: string,
): Promise<T | null> {
	if (await destination.statObject(path_object) === null) {
		return null;
	}
	return JSON.parse(
		(await destination.getObject(path_object)).toString("utf8"),
	) as T;
}

async function writeJsonObject(
	destination: BackupDestination,
	path_object: string,
	value_object: unknown,
	create_only = false,
): Promise<DestinationObject> {
	return destination.putObject(
		path_object,
		Buffer.from(`${JSON.stringify(value_object, null, 2)}\n`),
		{
			...(create_only ? { if_generation_match: 0 } : {}),
			metadata: { content_type: "application/json" },
		},
	);
}

async function readBackupBlob(
	context: RestoreContext,
	reference_blob: BackupBlobReference,
) {
	if (reference_blob.provider === "copy") {
		const data_object = await context.recovery.destination.getObject(
			reference_blob.path,
		);
		return { data: data_object };
	}
	if (context.source_blob_bucket === undefined) {
		throw new Error("GCS inventory restore requires the source GCS blob configuration");
	}
	return {
		data: await readGcsGeneration(
			context.source_blob_bucket,
			reference_blob.path,
			reference_blob.generation,
		),
	};
}

async function runBlobRestore(
	context: RestoreContext,
	backup_id: string,
	path_journal: string,
) {
	const recovery_point = await inspectRecoveryPoint(
		context.recovery.destination,
		context.source_config.deployment_id,
		backup_id,
	);
	const receipt_blob = recovery_point.manifest.components.blob;
	return restoreBlobStorage({
		receipt: receipt_blob,
		inventory_data: await context.recovery.destination.getObject(
			receipt_blob.inventory_path,
		),
		read_backup_object: async (reference_blob) =>
			readBackupBlob(context, reference_blob),
		stat_target_object: context.target_blob.destination.statObject,
		write_target_object: async (path_object, data_object, overwrite) =>
			context.target_blob.destination.putObject(
				path_object,
				data_object,
				overwrite ? {} : { if_generation_match: 0 },
			),
		read_journal: async () =>
			(await readJsonObject<RestoreBlobJournalEntry[]>(
				context.recovery.destination,
				path_journal,
			)) ?? [],
		append_journal: async (entry_journal) => {
			const entries_journal = (await readJsonObject<RestoreBlobJournalEntry[]>(
				context.recovery.destination,
				path_journal,
			)) ?? [];
			entries_journal.push(entry_journal);
			await writeJsonObject(
				context.recovery.destination,
				path_journal,
				entries_journal,
			);
		},
	});
}

async function runPostgresRestore(context: RestoreContext, backup_id: string) {
	const recovery_point = await inspectRecoveryPoint(
		context.recovery.destination,
		context.source_config.deployment_id,
		backup_id,
	);
	return restorePostgres({
		receipt: recovery_point.manifest.components.postgres,
		target_database_url: context.target_postgres_url,
		check_target_empty: async () => isPostgresEmpty(context),
		download_dump: context.recovery.destination.getObject,
		pg_restore_path: context.target_config.postgres.pg_restore_path,
	});
}

async function runClickhouseRestore(context: RestoreContext, backup_id: string) {
	const recovery_point = await inspectRecoveryPoint(
		context.recovery.destination,
		context.source_config.deployment_id,
		backup_id,
	);
	return restoreClickhouse({
		query: context.query_target,
		receipt: recovery_point.manifest.components.clickhouse,
		named_collection: context.target_config.clickhouse.named_collection,
		check_target_empty: async () => isClickhouseEmpty(context),
	});
}

async function runHealthChecks(
	context: RestoreContext,
	allow_container_hooks: boolean,
): Promise<void> {
	await Promise.all([
		runTargetPsql(context, "SELECT 1"),
		context.query_target("SELECT 1 AS healthy FORMAT JSON"),
		context.target_blob.bucket.getMetadata(),
	]);
	for (const hook of context.target_config.health_checks) {
		await runHook({
			command: hook.command,
			timeout_ms: hook.timeout_ms,
			shell: hook.shell,
			allow_container_hooks,
		});
	}
}

async function runSmokeTest(
	context: RestoreContext,
	allow_container_hooks: boolean,
): Promise<void> {
	const hook = context.target_config.smoke_test;
	await runHook({
		command: hook.command,
		timeout_ms: hook.timeout_ms,
		shell: hook.shell,
		allow_container_hooks,
	});
}

export async function runRestoreRuntime(
	options: RestoreRuntimeOptions,
): Promise<RunRestoreResult> {
	const context = await createRestoreContext(options);
	const paths_restore = getRestoreRuntimePaths(
		context.target_config.deployment_id,
		options.expected_backup_id,
	);
	return runRestore({
		create_plan: async () => createPlan(
			context,
			options.expected_backup_id,
			options.accept_online_consistency,
		),
		target_config_path: options.path_target,
		confirm: options.confirm,
		expected_backup_id: options.expected_backup_id,
		acquire_target_lock: async () =>
			writeJsonObject(
				context.recovery.destination,
				paths_restore.lock,
				{
					backup_id: options.expected_backup_id,
					target_deployment_id: context.target_config.deployment_id,
					acquired_at: new Date().toISOString(),
				},
				true,
			),
		release_target_lock: async (lock_target) => {
			const object_lock = lock_target as DestinationObject;
			await context.recovery.destination.deleteObject(
				object_lock.path,
				object_lock.generation,
			);
		},
		read_journal: async () =>
			readJsonObject<RestoreJournal>(
				context.recovery.destination,
				paths_restore.journal,
			),
		write_journal: async (journal_restore) => {
			await writeJsonObject(
				context.recovery.destination,
				paths_restore.journal,
				journal_restore,
			);
		},
		restore_blob: async () =>
			runBlobRestore(
				context,
				options.expected_backup_id,
				paths_restore.blob_journal,
			),
		restore_postgres: async () =>
			runPostgresRestore(context, options.expected_backup_id),
		restore_clickhouse: async () =>
			runClickhouseRestore(context, options.expected_backup_id),
		run_health_checks: async () =>
			runHealthChecks(context, options.allow_container_hooks),
		run_smoke_tests: async () =>
			runSmokeTest(context, options.allow_container_hooks),
		write_report: async () => {
			await writeJsonObject(context.recovery.destination, paths_restore.report, {
				backup_id: options.expected_backup_id,
				target_deployment_id: context.target_config.deployment_id,
				completed_at: new Date().toISOString(),
				status: "complete",
			});
			return paths_restore.report;
		},
	});
}

export async function runRestorePlanRuntime(
	options: RestorePlanRuntimeOptions,
): Promise<RestorePlan> {
	const context = await createRestoreContext(options);
	return createPlan(
		context,
		options.backup_id,
		options.accept_online_consistency,
	);
}
