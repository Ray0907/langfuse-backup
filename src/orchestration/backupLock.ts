import type { BackupDestination } from "../destination/types.js";

interface BackupLockRecord {
	deployment_id: string;
	backup_id: string;
	acquired_at: string;
	expires_at: string;
}

export interface BackupLock extends BackupLockRecord {
	path: string;
	generation: number;
}

export interface AcquireLockOptions {
	now?: Date;
	ttl_ms?: number;
	takeover_expired?: boolean;
}

function getLockPath(deployment_id: string): string {
	return `locks/${encodeURIComponent(deployment_id)}.json`;
}

function getErrorCode(error: unknown): number | undefined {
	if (error !== null && typeof error === "object" && "code" in error) {
		const code_error = Reflect.get(error, "code");
		return typeof code_error === "number" ? code_error : undefined;
	}
	return undefined;
}

export async function acquireBackupLock(
	destination: BackupDestination,
	deployment_id: string,
	backup_id: string,
	options: AcquireLockOptions = {},
): Promise<BackupLock> {
	const time_now = options.now ?? new Date();
	const ttl_ms = options.ttl_ms ?? 15 * 60_000;
	const path_lock = getLockPath(deployment_id);
	const record_lock: BackupLockRecord = {
		deployment_id,
		backup_id,
		acquired_at: time_now.toISOString(),
		expires_at: new Date(time_now.getTime() + ttl_ms).toISOString(),
	};
	const data_lock = Buffer.from(`${JSON.stringify(record_lock)}\n`);

	try {
		const metadata_lock = await destination.putObject(path_lock, data_lock, {
			if_generation_match: 0,
		});
		return { ...record_lock, path: path_lock, generation: metadata_lock.generation };
	} catch (error) {
		if (getErrorCode(error) !== 412) {
			throw error;
		}
	}

	const metadata_existing = await destination.statObject(path_lock);
	if (metadata_existing === null) {
		throw new Error(`Backup lock race detected for ${deployment_id}`);
	}
	const record_existing = JSON.parse(
		(await destination.getObject(path_lock)).toString("utf8"),
	) as BackupLockRecord;
	const is_expired = Date.parse(record_existing.expires_at) <= time_now.getTime();

	if (!is_expired) {
		throw new Error(`Deployment ${deployment_id} is locked by ${record_existing.backup_id}`);
	}
	if (options.takeover_expired !== true) {
		throw new Error(`Expired lock requires explicit takeover for ${deployment_id}`);
	}

	const metadata_lock = await destination.putObject(path_lock, data_lock, {
		if_generation_match: metadata_existing.generation,
	});
	return { ...record_lock, path: path_lock, generation: metadata_lock.generation };
}

export async function releaseBackupLock(
	destination: BackupDestination,
	lock_backup: BackupLock,
): Promise<void> {
	await destination.deleteObject(lock_backup.path, lock_backup.generation);
}
