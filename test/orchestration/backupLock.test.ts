import { describe, expect, it } from "vitest";

import type {
	Destination,
	DestinationObject,
	WriteOptions,
} from "../../src/destination/types.js";
import { acquireBackupLock } from "../../src/orchestration/backupLock.js";

function createLockDestination(initial_lock?: DestinationObject): Destination {
	let object_lock = initial_lock;

	return {
		async writeBuffer() {
			throw new Error("not used");
		},
		async writeJson(path_object, value_object, options_write: WriteOptions = {}) {
			if (options_write.if_generation_match === 0 && object_lock !== undefined) {
				throw Object.assign(new Error("locked"), {
					code: "PRECONDITION_FAILED",
				});
			}
			if (
				options_write.if_generation_match !== undefined
				&& options_write.if_generation_match !== 0
				&& object_lock?.generation !== options_write.if_generation_match
			) {
				throw Object.assign(new Error("changed"), {
					code: "PRECONDITION_FAILED",
				});
			}
			object_lock = {
				path: path_object,
				data: Buffer.from(JSON.stringify(value_object)),
				generation: (object_lock?.generation ?? 0) + 1,
				size_bytes: 1,
				metadata: {},
			};
			return object_lock;
		},
		async readObject() {
			if (object_lock === undefined) {
				throw Object.assign(new Error("missing"), { code: "NOT_FOUND" });
			}
			return object_lock;
		},
		async getMetadata() {
			if (object_lock === undefined) {
				throw Object.assign(new Error("missing"), { code: "NOT_FOUND" });
			}
			return object_lock;
		},
		async deleteObject(_path_object, options_delete = {}) {
			if (
				object_lock === undefined
				|| (
					options_delete.if_generation_match !== undefined
					&& object_lock.generation !== options_delete.if_generation_match
				)
			) {
				throw Object.assign(new Error("changed"), {
					code: "PRECONDITION_FAILED",
				});
			}
			object_lock = undefined;
		},
		async listCommittedManifestPaths() {
			return [];
		},
	};
}

describe("backup lock", () => {
	it("rejects a second active lock", async () => {
		const destination = createLockDestination();
		const time_now = new Date("2026-07-24T10:00:00.000Z");

		await acquireBackupLock(destination, {
			deployment_id: "source",
			owner_id: "owner-1",
			time_now,
			ttl_ms: 60_000,
		});

		await expect(acquireBackupLock(destination, {
			deployment_id: "source",
			owner_id: "owner-2",
			time_now,
			ttl_ms: 60_000,
		})).rejects.toThrow(/active/i);
	});

	it("requires an explicit flag before taking over an expired lock", async () => {
		const destination = createLockDestination({
			path: "locks/source.json",
			data: Buffer.from(JSON.stringify({
				owner_id: "owner-old",
				expires_at: "2026-07-24T09:00:00.000Z",
			})),
			generation: 4,
			size_bytes: 1,
			metadata: {},
		});
		const options_lock = {
			deployment_id: "source",
			owner_id: "owner-new",
			time_now: new Date("2026-07-24T10:00:00.000Z"),
			ttl_ms: 60_000,
		};

		await expect(acquireBackupLock(destination, options_lock))
			.rejects.toThrow(/takeover/i);

		const lock_acquired = await acquireBackupLock(destination, {
			...options_lock,
			takeover_expired: true,
		});

		expect(lock_acquired.generation).toBe(5);
		await expect(lock_acquired.release()).resolves.toBeUndefined();
	});
});

