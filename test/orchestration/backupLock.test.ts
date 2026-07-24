import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type {
	BackupDestination,
	DestinationObject,
	PutObjectOptions,
} from "../../src/destination/types.js";
import {
	acquireBackupLock,
	releaseBackupLock,
} from "../../src/orchestration/backupLock.js";

function createObject(
	path_object: string,
	data_object: Buffer,
	generation: number,
): DestinationObject {
	return {
		path: path_object,
		generation,
		size_bytes: data_object.byteLength,
		sha256: createHash("sha256").update(data_object).digest("hex"),
		updated_at: "2026-07-24T10:00:00.000Z",
		metadata: {},
	};
}

function createLockDestination(initial_data?: Buffer): BackupDestination {
	let data_lock = initial_data;
	let metadata_lock = initial_data === undefined
		? undefined
		: createObject("locks/source.json", initial_data, 4);

	return {
		async putObject(path_object, data_object, options_write: PutObjectOptions = {}) {
			if (options_write.if_generation_match === 0 && metadata_lock !== undefined) {
				throw Object.assign(new Error("locked"), { code: 412 });
			}
			if (
				options_write.if_generation_match !== undefined
				&& options_write.if_generation_match !== 0
				&& metadata_lock?.generation !== options_write.if_generation_match
			) {
				throw Object.assign(new Error("changed"), { code: 412 });
			}
			data_lock = data_object;
			metadata_lock = createObject(
				path_object,
				data_object,
				(metadata_lock?.generation ?? 0) + 1,
			);
			return metadata_lock;
		},
		async getObject() {
			if (data_lock === undefined) {
				throw Object.assign(new Error("missing"), { code: 404 });
			}
			return data_lock;
		},
		async statObject() {
			return metadata_lock ?? null;
		},
		async deleteObject(_path_object, generation) {
			if (metadata_lock?.generation !== generation) {
				throw Object.assign(new Error("changed"), { code: 412 });
			}
			data_lock = undefined;
			metadata_lock = undefined;
		},
		async listObjects() {
			return metadata_lock === undefined ? [] : [metadata_lock];
		},
	};
}

describe("backup lock", () => {
	it("rejects a second active lock", async () => {
		const destination = createLockDestination();
		const time_now = new Date("2026-07-24T10:00:00.000Z");

		await acquireBackupLock(destination, "source", "backup-1", {
			now: time_now,
			ttl_ms: 60_000,
		});

		await expect(acquireBackupLock(destination, "source", "backup-2", {
			now: time_now,
			ttl_ms: 60_000,
		})).rejects.toThrow(/locked/i);
	});

	it("requires explicit takeover for an expired lock", async () => {
		const destination = createLockDestination(Buffer.from(JSON.stringify({
			deployment_id: "source",
			backup_id: "backup-old",
			acquired_at: "2026-07-24T08:00:00.000Z",
			expires_at: "2026-07-24T09:00:00.000Z",
		})));
		const options_lock = {
			now: new Date("2026-07-24T10:00:00.000Z"),
			ttl_ms: 60_000,
		};

		await expect(acquireBackupLock(
			destination,
			"source",
			"backup-new",
			options_lock,
		)).rejects.toThrow(/takeover/i);

		const lock_acquired = await acquireBackupLock(
			destination,
			"source",
			"backup-new",
			{ ...options_lock, takeover_expired: true },
		);

		expect(lock_acquired.generation).toBe(5);
		await expect(releaseBackupLock(destination, lock_acquired)).resolves.toBeUndefined();
	});
});

