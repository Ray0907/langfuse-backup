import type { BackupDestination } from "../destination/types.js";
import type { QueueSnapshot } from "../adapters/redis/queueInspector.js";
import type {
	BlobReceipt,
	ClickhouseReceipt,
	PostgresReceipt,
	RecoveryManifest,
} from "../manifest/schema.js";
import { serializeManifest } from "../manifest/serializeManifest.js";
import {
	acquireBackupLock,
	releaseBackupLock,
	type BackupLock,
} from "./backupLock.js";
import { BackupState } from "./backupState.js";
import { verifyBackupReceipts } from "./verifyBackup.js";
import { waitForQueueDrain } from "./waitForQueueDrain.js";

export type BackupStage =
	| "lock"
	| "preflight"
	| "pre_hook"
	| "drain"
	| "boundary"
	| "postgres"
	| "clickhouse"
	| "blob"
	| "verify"
	| "manifest"
	| "post_hook"
	| "unlock";

export interface CreateBackupOptions {
	destination: BackupDestination;
	deployment_id: string;
	backup_id: string;
	consistency_mode?: "online" | "coordinated";
	consistency?: {
		mode: "online";
	} | {
		mode: "coordinated";
		run_pre_hook: () => Promise<void>;
		wait_for_queue_drain: () => Promise<QueueSnapshot>;
		run_post_hook: () => Promise<void>;
	};
	allow_active_writes: boolean;
	preflight: () => Promise<void>;
	run_pre_hook?: () => Promise<void>;
	run_post_hook?: () => Promise<void>;
	inspect_queues?: () => Promise<QueueSnapshot>;
	queue_drain_timeout_ms?: number;
	queue_poll_interval_ms?: number;
	queue_sleep?: (duration_ms: number) => Promise<void>;
	queue_get_time_ms?: () => number;
	backup_postgres: () => Promise<PostgresReceipt>;
	backup_clickhouse: () => Promise<ClickhouseReceipt>;
	backup_blob: () => Promise<BlobReceipt>;
	tool_version: string;
	source_revision: string;
	required_secrets: string[];
	takeover_expired_lock?: boolean;
	on_stage?: (stage_backup: BackupStage) => void | Promise<void>;
	now?: () => Date;
}

export interface CreateBackupResult {
	manifest: RecoveryManifest;
	manifest_path: string;
	manifest_sha256: string;
}

function getManifestPath(deployment_id: string, backup_id: string): string {
	return `deployments/${encodeURIComponent(deployment_id)}/backups/`
		+ `${encodeURIComponent(backup_id)}/manifest.json`;
}

async function reportStage(
	options: CreateBackupOptions,
	stage_backup: BackupStage,
): Promise<void> {
	await options.on_stage?.(stage_backup);
}

export async function createBackup(
	options: CreateBackupOptions,
): Promise<CreateBackupResult> {
	const consistency_mode = options.consistency?.mode
		?? options.consistency_mode
		?? "online";
	const consistency_coordinated = options.consistency?.mode === "coordinated"
		? options.consistency
		: undefined;
	const run_pre_hook = consistency_coordinated?.run_pre_hook
		?? options.run_pre_hook;
	const run_post_hook = consistency_coordinated?.run_post_hook
		?? options.run_post_hook;
	if (consistency_mode === "online" && !options.allow_active_writes) {
		throw new Error("Online backup requires --allow-active-writes");
	}
	if (consistency_mode === "coordinated"
		&& (run_pre_hook === undefined
			|| run_post_hook === undefined
			|| (consistency_coordinated === undefined
				&& options.inspect_queues === undefined))) {
		throw new Error("Coordinated backup requires hooks and a queue inspector");
	}

	const get_now = options.now ?? (() => new Date());
	const state_backup = new BackupState();
	const created_at = get_now().toISOString();
	let lock_backup: BackupLock | undefined;
	let should_run_post_hook = false;

	try {
		lock_backup = await acquireBackupLock(
			options.destination,
			options.deployment_id,
			options.backup_id,
			{
				...(options.takeover_expired_lock === undefined
					? {}
					: { takeover_expired: options.takeover_expired_lock }),
			},
		);
		state_backup.transition("locked");
		await reportStage(options, "lock");

		await options.preflight();
		state_backup.transition("preflight_passed");
		await reportStage(options, "preflight");
		let boundary_at: string;
		let queue_drained_at: string | undefined;
		if (consistency_mode === "coordinated") {
			should_run_post_hook = true;
			await run_pre_hook?.();
			await reportStage(options, "pre_hook");
			const snapshot_drained = consistency_coordinated === undefined
				? await waitForQueueDrain({
					inspect: options.inspect_queues as () => Promise<QueueSnapshot>,
					timeout_ms: options.queue_drain_timeout_ms ?? 300_000,
					...(options.queue_poll_interval_ms === undefined
						? {}
						: { poll_interval_ms: options.queue_poll_interval_ms }),
					...(options.queue_sleep === undefined
						? {}
						: { sleep: options.queue_sleep }),
					...(options.queue_get_time_ms === undefined
						? {}
						: { get_time_ms: options.queue_get_time_ms }),
				})
				: await consistency_coordinated.wait_for_queue_drain();
			if (snapshot_drained.pending_count !== 0
				|| snapshot_drained.failed_count !== 0) {
				throw new Error(
					`Queue is not drained: ${snapshot_drained.pending_count} pending, `
					+ `${snapshot_drained.failed_count} failed`,
				);
			}
			queue_drained_at = snapshot_drained.captured_at;
			await reportStage(options, "drain");
			boundary_at = get_now().toISOString();
			await reportStage(options, "boundary");
		} else {
			boundary_at = get_now().toISOString();
		}
		state_backup.transition("quiesced");

		const receipt_postgres = await options.backup_postgres();
		state_backup.recordReceipt("postgres", receipt_postgres);
		state_backup.transition("postgres_complete");
		await reportStage(options, "postgres");

		const receipt_clickhouse = await options.backup_clickhouse();
		state_backup.recordReceipt("clickhouse", receipt_clickhouse);
		state_backup.transition("clickhouse_complete");
		await reportStage(options, "clickhouse");

		const receipt_blob = await options.backup_blob();
		state_backup.recordReceipt("blob", receipt_blob);
		state_backup.transition("blob_complete");
		await reportStage(options, "blob");

		const receipts_verified = verifyBackupReceipts({
			postgres: receipt_postgres,
			clickhouse: receipt_clickhouse,
			blob: receipt_blob,
		});
		state_backup.transition("verified");
		await reportStage(options, "verify");

		const committed_at = get_now().toISOString();
		const manifest_input = {
			schema_version: "1.0.0",
			backup_id: options.backup_id,
			deployment_id: options.deployment_id,
			created_at,
			committed_at,
			tool: {
				version: options.tool_version,
				source_revision: options.source_revision,
			},
			consistency: {
				mode: consistency_mode,
				boundary_at,
				...(queue_drained_at === undefined ? {} : { queue_drained_at }),
			},
			components: receipts_verified,
			required_secrets: [...options.required_secrets].sort(),
		};
		const manifest_serialized = serializeManifest(manifest_input);
		const manifest_path = getManifestPath(
			options.deployment_id,
			options.backup_id,
		);
		await options.destination.putObject(
			manifest_path,
			Buffer.from(manifest_serialized.json),
			{
				if_generation_match: 0,
				metadata: {
					sha256: manifest_serialized.sha256,
					schema_version: manifest_serialized.manifest.schema_version,
				},
			},
		);
		state_backup.transition("committed");
		await reportStage(options, "manifest");

		return {
			manifest: manifest_serialized.manifest,
			manifest_path,
			manifest_sha256: manifest_serialized.sha256,
		};
	} finally {
		try {
			if (should_run_post_hook) {
				await run_post_hook?.();
				await reportStage(options, "post_hook");
			}
		} finally {
			if (lock_backup !== undefined) {
				await releaseBackupLock(options.destination, lock_backup);
				await reportStage(options, "unlock");
			}
		}
	}
}
