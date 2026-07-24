import type { BackupDestination } from "../destination/types.js";
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

export type BackupStage =
	| "lock"
	| "preflight"
	| "postgres"
	| "clickhouse"
	| "blob"
	| "verify"
	| "manifest"
	| "unlock";

export interface CreateBackupOptions {
	destination: BackupDestination;
	deployment_id: string;
	backup_id: string;
	allow_active_writes: boolean;
	preflight: () => Promise<void>;
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
	if (!options.allow_active_writes) {
		throw new Error("Online backup requires --allow-active-writes");
	}

	const get_now = options.now ?? (() => new Date());
	const state_backup = new BackupState();
	const created_at = get_now().toISOString();
	let lock_backup: BackupLock | undefined;

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

		const boundary_at = get_now().toISOString();
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
				mode: "online" as const,
				boundary_at,
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
		if (lock_backup !== undefined) {
			await releaseBackupLock(options.destination, lock_backup);
			await reportStage(options, "unlock");
		}
	}
}
