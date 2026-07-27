import { createServer, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createPostgresBackup } from "../../src/adapters/postgres/postgresBackup.js";
import { createClickhouseBackup } from "../../src/adapters/clickhouse/clickhouseBackup.js";
import type { ClickhouseQuery } from "../../src/adapters/clickhouse/queryBackupStatus.js";
import type { BackupDestination } from "../../src/destination/types.js";
import type {
	PostgresReceipt,
	RecoveryManifest,
} from "../../src/manifest/schema.js";
import { createBackup } from "../../src/orchestration/createBackup.js";
import { createRestorePlan } from "../../src/restore/restorePlan.js";
import { restoreClickhouse } from "../../src/restore/restoreClickhouse.js";
import { restorePostgres } from "../../src/restore/restorePostgres.js";
import {
	runRestore,
	type RestoreJournal,
	type RestoreStage,
} from "../../src/restore/runRestore.js";
import { LocalDestination } from "./support/localDestination.js";
import {
	createComposeArgs,
	createContainerProcessRunner,
	runText,
} from "./support/process.js";
import {
	backupBlobs,
	countS3Objects,
	createClickhouseQuery,
	createS3Fixture,
	ensureBucket,
	getComposePort,
	getS3Object,
	putS3Object,
	restoreBlobs,
	waitForHttp,
	type S3Fixture,
} from "./support/services.js";

const path_source = resolve("test/fixtures/docker-compose.source.yml");
const path_target = resolve("test/fixtures/docker-compose.target.yml");
const image_minio = "minio/minio@sha256:"
	+ "14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e";
const summary_success = "Recovery E2E passed: backup committed, source destroyed, "
	+ "target restored, PostgreSQL verified, ClickHouse verified, blobs verified, "
	+ "API smoke test passed.";

interface RecoveryContext {
	id_run: string;
	name_source: string;
	name_target: string;
	name_store: string;
	path_backup: string;
	env: NodeJS.ProcessEnv;
	source_blob?: S3Fixture;
	target_blob?: S3Fixture;
	recovery_store?: S3Fixture;
}

const contexts_cleanup: RecoveryContext[] = [];

afterEach(async () => {
	const contexts = contexts_cleanup.splice(0);
	await Promise.all(contexts.map(cleanupRecovery));
});

describe("disaster recovery", () => {
	it("backs up, destroys the source, restores an isolated target, and verifies it",
		async () => {
			if (process.env.RUN_RECOVERY_E2E !== "1") {
				throw new Error("Recovery E2E must run through scripts/run-recovery-e2e.sh");
			}
			logRecoveryPhase("create-context");
			const context = await createRecoveryContext();
			contexts_cleanup.push(context);
			logRecoveryPhase("start-services");
			await startRecoveryServices(context);
			logRecoveryPhase("run-recovery");
			const result_recovery = await runRecovery(context);

			expect(result_recovery.source_destroyed).toBe(true);
			expect(result_recovery.journal.status).toBe("complete");
			expect(result_recovery.stages).toEqual([
				"plan",
				"confirmation",
				"target_lock",
				"blob",
				"postgres",
				"clickhouse",
				"health_checks",
				"smoke_tests",
				"report",
				"target_unlock",
			]);
			process.stdout.write(`${summary_success}\n`);
			logRecoveryPhase("complete");
		});
});

async function createRecoveryContext(): Promise<RecoveryContext> {
	const id_run = randomUUID().replaceAll("-", "").slice(0, 12);
	const path_backup = await mkdtemp(`${tmpdir()}/langfuse-recovery-${id_run}-`);
	const random_secret = (): string => randomUUID().replaceAll("-", "");
	return {
		id_run,
		name_source: `lf-source-${id_run}`,
		name_target: `lf-target-${id_run}`,
		name_store: `lf-recovery-${id_run}`,
		path_backup,
		env: {
			...process.env,
			SOURCE_DEPLOYMENT_ID: `source-${id_run}`,
			TARGET_DEPLOYMENT_ID: `target-${id_run}`,
			SOURCE_POSTGRES_PASSWORD: random_secret(),
			TARGET_POSTGRES_PASSWORD: random_secret(),
			SOURCE_CLICKHOUSE_PASSWORD: random_secret(),
			TARGET_CLICKHOUSE_PASSWORD: random_secret(),
			SOURCE_BLOB_ACCESS_KEY: `source${id_run}`,
			SOURCE_BLOB_SECRET_KEY: random_secret(),
			TARGET_BLOB_ACCESS_KEY: `target${id_run}`,
			TARGET_BLOB_SECRET_KEY: random_secret(),
			RECOVERY_STORE_ACCESS_KEY: `recovery${id_run}`,
			RECOVERY_STORE_SECRET_KEY: random_secret(),
		},
	};
}

async function startRecoveryServices(context: RecoveryContext): Promise<void> {
	await runText("docker", createComposeArgs(
		path_source,
		context.name_source,
		["up", "--detach", "--wait"],
	), { env: context.env });
	logRecoveryPhase("source-services-ready");
	await runText("docker", createComposeArgs(
		path_target,
		context.name_target,
		["up", "--detach", "--wait"],
	), { env: context.env });
	logRecoveryPhase("target-services-ready");
	await runText("docker", [
		"run",
		"--detach",
		"--rm",
		"--name",
		context.name_store,
		"--network",
		`${context.name_source}_default`,
		"--network-alias",
		"recovery-store",
		"--publish",
		"127.0.0.1::9000",
		"--env",
		"MINIO_ROOT_USER",
		"--env",
		"MINIO_ROOT_PASSWORD",
		image_minio,
		"server",
		"/data",
		"--address",
		":9000",
	], {
		env: {
			...context.env,
			MINIO_ROOT_USER: context.env.RECOVERY_STORE_ACCESS_KEY,
			MINIO_ROOT_PASSWORD: context.env.RECOVERY_STORE_SECRET_KEY,
		},
	});
	logRecoveryPhase("recovery-store-started");
	await runText("docker", [
		"network",
		"connect",
		"--alias",
		"recovery-store",
		`${context.name_target}_default`,
		context.name_store,
	]);
	await configureS3Fixtures(context);
	logRecoveryPhase("s3-fixtures-ready");
}

async function configureS3Fixtures(context: RecoveryContext): Promise<void> {
	const port_source = await getComposePort({
		path_compose: path_source,
		name_project: context.name_source,
		name_service: "blob",
		port_container: 9000,
		env: context.env,
	});
	const port_target = await getComposePort({
		path_compose: path_target,
		name_project: context.name_target,
		name_service: "blob",
		port_container: 9000,
		env: context.env,
	});
	const text_store_port = await runText(
		"docker",
		["port", context.name_store, "9000/tcp"],
	);
	const match_store_port = /:(\d+)$/.exec(text_store_port);
	if (match_store_port?.[1] === undefined) {
		throw new Error(`Unable to parse recovery-store port: ${text_store_port}`);
	}
	const port_store = Number(match_store_port[1]);
	await Promise.all([
		waitForHttp(`http://127.0.0.1:${port_source}/minio/health/live`),
		waitForHttp(`http://127.0.0.1:${port_target}/minio/health/live`),
		waitForHttp(`http://127.0.0.1:${port_store}/minio/health/live`),
	]);
	context.source_blob = createS3Fixture({
		endpoint: `http://127.0.0.1:${port_source}`,
		access_key: requireEnv(context, "SOURCE_BLOB_ACCESS_KEY"),
		secret_key: requireEnv(context, "SOURCE_BLOB_SECRET_KEY"),
		bucket: "langfuse-source",
	});
	context.target_blob = createS3Fixture({
		endpoint: `http://127.0.0.1:${port_target}`,
		access_key: requireEnv(context, "TARGET_BLOB_ACCESS_KEY"),
		secret_key: requireEnv(context, "TARGET_BLOB_SECRET_KEY"),
		bucket: "langfuse-target",
	});
	context.recovery_store = createS3Fixture({
		endpoint: `http://127.0.0.1:${port_store}`,
		access_key: requireEnv(context, "RECOVERY_STORE_ACCESS_KEY"),
		secret_key: requireEnv(context, "RECOVERY_STORE_SECRET_KEY"),
		bucket: "recovery",
	});
	await Promise.all([
		ensureBucket(context.source_blob),
		ensureBucket(context.target_blob),
		ensureBucket(context.recovery_store),
	]);
}

async function runRecovery(context: RecoveryContext): Promise<{
	source_destroyed: boolean;
	journal: RestoreJournal;
	stages: RestoreStage[];
}> {
	const source_blob = requireFixture(context.source_blob, "source blob");
	const target_blob = requireFixture(context.target_blob, "target blob");
	const recovery_store = requireFixture(context.recovery_store, "recovery store");
	const destination = new LocalDestination(context.path_backup);
	const backup_id = `backup-${context.id_run}`;
	const query_source = await getComposeClickhouseQuery(context, "source");
	const query_target = await getComposeClickhouseQuery(context, "target");
	logRecoveryPhase("database-clients-ready");
	await seedSource(context, source_blob, query_source);
	logRecoveryPhase("source-seeded");
	const result_backup = await createBackup({
		destination,
		deployment_id: requireEnv(context, "SOURCE_DEPLOYMENT_ID"),
		backup_id,
		consistency: {
			mode: "coordinated",
			run_pre_hook: async () => undefined,
			wait_for_queue_drain: async () => ({
				captured_at: new Date().toISOString(),
				queues: [],
				pending_count: 0,
				failed_count: 0,
			}),
			run_post_hook: async () => undefined,
		},
		allow_active_writes: false,
		preflight: async () => undefined,
		backup_postgres: async () => createFixturePostgresBackup(
			context,
			destination,
			backup_id,
		),
		backup_clickhouse: async () => createClickhouseBackup({
			query: query_source,
			deployment_id: requireEnv(context, "SOURCE_DEPLOYMENT_ID"),
			backup_id,
			database: "langfuse",
			named_collection: "recovery_store",
			max_poll_attempts: 60,
			sleep: async () => new Promise((resolve) => setTimeout(resolve, 250)),
		}),
		backup_blob: async () => backupBlobs({
			source: source_blob,
			destination,
			deployment_id: requireEnv(context, "SOURCE_DEPLOYMENT_ID"),
			backup_id,
			keys: ["events/raw-event.json", "media/image.txt"],
		}),
		tool_version: "0.1.0",
		source_revision: "recovery-e2e",
		required_secrets: [
			"RECOVERY_STORE_ACCESS_KEY",
			"RECOVERY_STORE_SECRET_KEY",
		],
	});
	logRecoveryPhase("backup-complete");
	const plan_restore = await createFixtureRestorePlan(
		context,
		destination,
		recovery_store,
		target_blob,
		result_backup.manifest,
		query_target,
	);
	logRecoveryPhase("restore-plan-complete");
	await destroySource(context);
	logRecoveryPhase("source-destroyed");
	const stages_restore: RestoreStage[] = [];
	let journal_restore: RestoreJournal | null = null;
	let target_locked = false;
	const result_restore = await runRestore({
		create_plan: async () => plan_restore,
		target_config_path: path_target,
		confirm: true,
		expected_backup_id: backup_id,
		acquire_target_lock: async () => {
			if (target_locked) {
				throw new Error("Target is already locked");
			}
			target_locked = true;
			return { backup_id };
		},
		release_target_lock: async () => {
			target_locked = false;
		},
		read_journal: async () => journal_restore,
		write_journal: async (value_journal) => {
			journal_restore = structuredClone(value_journal);
		},
		restore_blob: async () => restoreBlobs({
			receipt: result_backup.manifest.components.blob,
			destination,
			target: target_blob,
		}),
		restore_postgres: async () => restoreFixturePostgres(
			context,
			destination,
			result_backup.manifest.components.postgres,
		),
		restore_clickhouse: async () => restoreClickhouse({
			query: query_target,
			receipt: result_backup.manifest.components.clickhouse,
			named_collection: "recovery_store",
			check_target_empty: async () => isClickhouseTargetEmpty(query_target),
			max_poll_attempts: 60,
			sleep: async () => new Promise((resolve) => setTimeout(resolve, 250)),
		}),
		run_health_checks: async () => verifyTargetData(
			context,
			target_blob,
			query_target,
		),
		run_smoke_tests: async () => runApiSmoke(
			context,
			target_blob,
			query_target,
		),
		write_report: async () => {
			const path_report = `restore/${backup_id}/report.json`;
			await destination.putObject(
				path_report,
				Buffer.from(JSON.stringify({ backup_id, status: "complete" })),
				{ if_generation_match: 0 },
			);
			return path_report;
		},
		on_stage: (stage_restore) => {
			stages_restore.push(stage_restore);
		},
	});
	logRecoveryPhase("restore-complete");
	expect(await destination.statObject(result_backup.manifest_path)).not.toBeNull();
	expect(await destination.statObject(result_restore.report_path)).not.toBeNull();
	return {
		source_destroyed: true,
		journal: result_restore.journal,
		stages: stages_restore,
	};
}

async function getComposeClickhouseQuery(
	context: RecoveryContext,
	kind_deployment: "source" | "target",
): Promise<ClickhouseQuery> {
	const is_source = kind_deployment === "source";
	const port_clickhouse = await getComposePort({
		path_compose: is_source ? path_source : path_target,
		name_project: is_source ? context.name_source : context.name_target,
		name_service: "clickhouse",
		port_container: 8123,
		env: context.env,
	});
	const query_clickhouse = createClickhouseQuery({
		endpoint: `http://127.0.0.1:${port_clickhouse}`,
		password: requireEnv(
			context,
			is_source ? "SOURCE_CLICKHOUSE_PASSWORD" : "TARGET_CLICKHOUSE_PASSWORD",
		),
	});
	await query_clickhouse("SELECT version() AS version FORMAT JSON");
	return query_clickhouse;
}

async function seedSource(
	context: RecoveryContext,
	source_blob: S3Fixture,
	query_source: ClickhouseQuery,
): Promise<void> {
	const sql_postgres = [
		"CREATE TABLE users (id text PRIMARY KEY, email text NOT NULL)",
		"CREATE TABLE organizations (id text PRIMARY KEY, name text NOT NULL)",
		"CREATE TABLE projects (id text PRIMARY KEY, organization_id text NOT NULL)",
		"CREATE TABLE api_keys (id text PRIMARY KEY, project_id text NOT NULL)",
		"CREATE TABLE prompts (id text PRIMARY KEY, project_id text NOT NULL)",
		"CREATE TABLE datasets (id text PRIMARY KEY, project_id text NOT NULL)",
		"INSERT INTO users VALUES ('user-e2e', 'restore@example.test')",
		"INSERT INTO organizations VALUES ('org-e2e', 'Recovery Org')",
		"INSERT INTO projects VALUES ('project-e2e', 'org-e2e')",
		"INSERT INTO api_keys VALUES ('key-e2e', 'project-e2e')",
		"INSERT INTO prompts VALUES ('prompt-e2e', 'project-e2e')",
		"INSERT INTO datasets VALUES ('dataset-e2e', 'project-e2e')",
	].join("; ");
	await runSourcePsql(context, sql_postgres);
	await query_source("CREATE DATABASE langfuse");
	await query_source(
		"CREATE TABLE langfuse.traces (id String, name String) "
		+ "ENGINE = MergeTree ORDER BY id",
	);
	await query_source(
		"CREATE TABLE langfuse.observations (id String, trace_id String) "
		+ "ENGINE = MergeTree ORDER BY id",
	);
	await query_source(
		"CREATE TABLE langfuse.scores (id String, trace_id String, value Float64) "
		+ "ENGINE = MergeTree ORDER BY id",
	);
	await query_source("INSERT INTO langfuse.traces VALUES ('trace-e2e', 'recovery')");
	await query_source(
		"INSERT INTO langfuse.observations VALUES ('observation-e2e', 'trace-e2e')",
	);
	await query_source(
		"INSERT INTO langfuse.scores VALUES ('score-e2e', 'trace-e2e', 1.0)",
	);
	await Promise.all([
		putS3Object(
			source_blob,
			"events/raw-event.json",
			Buffer.from('{"id":"trace-e2e","type":"trace-create"}\n'),
		),
		putS3Object(
			source_blob,
			"media/image.txt",
			Buffer.from("representative-media-object\n"),
		),
	]);
}

async function runSourcePsql(
	context: RecoveryContext,
	sql_query: string,
): Promise<string> {
	return runText("docker", createComposeArgs(
		path_source,
		context.name_source,
		[
			"exec",
			"-T",
			"postgres",
			"psql",
			"-U",
			"langfuse",
			"-d",
			"langfuse",
			"-v",
			"ON_ERROR_STOP=1",
			"-tA",
			"-c",
			sql_query,
		],
	), { env: context.env });
}

async function runTargetPsql(
	context: RecoveryContext,
	sql_query: string,
): Promise<string> {
	return runText("docker", createComposeArgs(
		path_target,
		context.name_target,
		[
			"exec",
			"-T",
			"postgres",
			"psql",
			"-U",
			"langfuse",
			"-d",
			"langfuse",
			"-v",
			"ON_ERROR_STOP=1",
			"-tA",
			"-c",
			sql_query,
		],
	), { env: context.env });
}

async function createFixturePostgresBackup(
	context: RecoveryContext,
	destination: BackupDestination,
	backup_id: string,
): Promise<PostgresReceipt> {
	return createPostgresBackup({
		destination,
		deployment_id: requireEnv(context, "SOURCE_DEPLOYMENT_ID"),
		backup_id,
		database_url: "postgresql://langfuse@source/langfuse",
		run_process: createContainerProcessRunner({
			path_compose: path_source,
			name_project: context.name_source,
			name_service: "postgres",
			mode: "dump",
			env: context.env,
		}),
	});
}

async function createFixtureRestorePlan(
	context: RecoveryContext,
	destination: BackupDestination,
	recovery_store: S3Fixture,
	target_blob: S3Fixture,
	manifest_backup: RecoveryManifest,
	query_target: ClickhouseQuery,
) {
	const result_clickhouse_version = await query_target(
		"SELECT version() AS version FORMAT JSON",
	);
	const version_clickhouse = String(
		result_clickhouse_version.data[0]?.version ?? "",
	);
	const version_postgres = await runTargetPsql(context, "SHOW server_version");
	const count_postgres = await runTargetPsql(
		context,
		"SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname = 'public'",
	);
	return createRestorePlan({
		manifest: manifest_backup,
		source_langfuse_version: "3.0.0",
		target: {
			deployment_id: requireEnv(context, "TARGET_DEPLOYMENT_ID"),
			langfuse_version: "3.0.0",
			postgres_version: version_postgres,
			clickhouse_version: version_clickhouse,
			postgres_empty: count_postgres === "0",
			clickhouse_empty: await isClickhouseTargetEmpty(query_target),
			blob_empty: await countS3Objects(target_blob) === 0,
			secret_references: [
				"RECOVERY_STORE_ACCESS_KEY",
				"RECOVERY_STORE_SECRET_KEY",
			],
		},
		artifacts: {
			postgres: await destination.statObject(
				manifest_backup.components.postgres.object_path,
			),
			blob: await destination.statObject(
				manifest_backup.components.blob.inventory_path,
			),
			clickhouse_valid: await countS3Objects(
				recovery_store,
				manifest_backup.components.clickhouse.object_prefix,
			) > 0,
		},
	});
}

async function destroySource(context: RecoveryContext): Promise<void> {
	await runText("docker", createComposeArgs(
		path_source,
		context.name_source,
		["down", "--volumes", "--remove-orphans"],
	), { env: context.env });
	const ids_source = await runText("docker", createComposeArgs(
		path_source,
		context.name_source,
		["ps", "--all", "--quiet"],
	), { env: context.env });
	if (ids_source !== "") {
		throw new Error("Source containers still exist after destructive teardown");
	}
}

async function restoreFixturePostgres(
	context: RecoveryContext,
	destination: BackupDestination,
	receipt_postgres: PostgresReceipt,
): Promise<void> {
	await restorePostgres({
		receipt: receipt_postgres,
		target_database_url: "postgresql://langfuse@target/langfuse",
		check_target_empty: async () => await runTargetPsql(
			context,
			"SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname = 'public'",
		) === "0",
		download_dump: async (path_object) => destination.getObject(path_object),
		run_process: createContainerProcessRunner({
			path_compose: path_target,
			name_project: context.name_target,
			name_service: "postgres",
			mode: "restore",
			env: context.env,
		}),
	});
}

async function isClickhouseTargetEmpty(
	query_target: ClickhouseQuery,
): Promise<boolean> {
	const result_count = await query_target(
		"SELECT count() AS count FROM system.tables "
		+ "WHERE database = 'langfuse' FORMAT JSON",
	);
	return Number(result_count.data[0]?.count ?? -1) === 0;
}

async function countClickhouseRows(
	query_target: ClickhouseQuery,
	name_table: string,
): Promise<number> {
	const result_count = await query_target(
		`SELECT count() AS count FROM langfuse.${name_table} FORMAT JSON`,
	);
	return Number(result_count.data[0]?.count ?? -1);
}

async function verifyTargetData(
	context: RecoveryContext,
	target_blob: S3Fixture,
	query_target: ClickhouseQuery,
): Promise<void> {
	const sql_count = [
		"(SELECT count(*) FROM users WHERE id = 'user-e2e')",
		"(SELECT count(*) FROM organizations WHERE id = 'org-e2e')",
		"(SELECT count(*) FROM projects WHERE id = 'project-e2e')",
		"(SELECT count(*) FROM api_keys WHERE id = 'key-e2e')",
		"(SELECT count(*) FROM prompts WHERE id = 'prompt-e2e')",
		"(SELECT count(*) FROM datasets WHERE id = 'dataset-e2e')",
	].join(" + ");
	expect(await runTargetPsql(context, `SELECT ${sql_count}`)).toBe("6");
	expect(await countClickhouseRows(query_target, "traces")).toBe(1);
	expect(await countClickhouseRows(query_target, "observations")).toBe(1);
	expect(await countClickhouseRows(query_target, "scores")).toBe(1);
	expect(await getS3Object(target_blob, "events/raw-event.json")).toEqual(
		Buffer.from('{"id":"trace-e2e","type":"trace-create"}\n'),
	);
	expect(await getS3Object(target_blob, "media/image.txt")).toEqual(
		Buffer.from("representative-media-object\n"),
	);
}

async function runApiSmoke(
	context: RecoveryContext,
	target_blob: S3Fixture,
	query_target: ClickhouseQuery,
): Promise<void> {
	const server_api = createServer((request, response) => {
		void handleApiRequest(
			request.url ?? "",
			response,
			context,
			target_blob,
			query_target,
		);
	});
	await new Promise<void>((resolve_listen) =>
		server_api.listen(0, "127.0.0.1", resolve_listen));
	try {
		const address_server = server_api.address();
		if (address_server === null || typeof address_server === "string") {
			throw new Error("Public API fixture did not bind a TCP port");
		}
		const response_api = await fetch(
			`http://127.0.0.1:${address_server.port}/api/public/traces/trace-e2e`,
		);
		expect(response_api.status).toBe(200);
		expect(await response_api.json()).toMatchObject({
			id: "trace-e2e",
			project_id: "project-e2e",
			raw_event_present: true,
		});
	} finally {
		await new Promise<void>((resolve_close, reject_close) => {
			server_api.close((error_close) => {
				if (error_close === undefined) {
					resolve_close();
				} else {
					reject_close(error_close);
				}
			});
		});
	}
}

async function handleApiRequest(
	path_request: string,
	response: ServerResponse,
	context: RecoveryContext,
	target_blob: S3Fixture,
	query_target: ClickhouseQuery,
): Promise<void> {
	try {
		if (path_request !== "/api/public/traces/trace-e2e") {
			response.writeHead(404).end();
			return;
		}
		const id_project = await runTargetPsql(
			context,
			"SELECT id FROM projects WHERE id = 'project-e2e'",
		);
		const result_trace = await query_target(
			"SELECT id FROM langfuse.traces WHERE id = 'trace-e2e' FORMAT JSON",
		);
		const raw_event = await getS3Object(target_blob, "events/raw-event.json");
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify({
			id: result_trace.data[0]?.id,
			project_id: id_project,
			raw_event_present: raw_event.byteLength > 0,
		}));
	} catch (error) {
		response.writeHead(500, { "content-type": "text/plain" });
		response.end(error instanceof Error ? error.message : String(error));
	}
}

async function cleanupRecovery(context: RecoveryContext): Promise<void> {
	context.source_blob?.client.destroy();
	context.target_blob?.client.destroy();
	context.recovery_store?.client.destroy();
	await Promise.allSettled([
		runText("docker", createComposeArgs(
			path_source,
			context.name_source,
			["down", "--volumes", "--remove-orphans"],
		), { env: context.env }),
		runText("docker", createComposeArgs(
			path_target,
			context.name_target,
			["down", "--volumes", "--remove-orphans"],
		), { env: context.env }),
		runText("docker", ["rm", "--force", context.name_store]),
	]);
	await rm(context.path_backup, { recursive: true, force: true });
}

function requireEnv(context: RecoveryContext, name_value: string): string {
	const value_environment = context.env[name_value];
	if (value_environment === undefined || value_environment === "") {
		throw new Error(`Missing recovery environment value: ${name_value}`);
	}
	return value_environment;
}

function requireFixture<T>(value_fixture: T | undefined, name_fixture: string): T {
	if (value_fixture === undefined) {
		throw new Error(`Missing recovery fixture: ${name_fixture}`);
	}
	return value_fixture;
}

function logRecoveryPhase(name_phase: string): void {
	if (process.env.RECOVERY_E2E_DIAGNOSTICS !== "1") {
		return;
	}
	process.stderr.write(
		`Recovery E2E phase: ${name_phase} (${Math.round(performance.now())}ms)\n`,
	);
}
