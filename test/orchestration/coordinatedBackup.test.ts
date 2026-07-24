import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { QueueSnapshot } from "../../src/adapters/redis/queueInspector.js";
import type {
	BackupDestination,
	DestinationObject,
} from "../../src/destination/types.js";
import type {
	BlobReceipt,
	ClickhouseReceipt,
	PostgresReceipt,
} from "../../src/manifest/schema.js";
import { createBackup } from "../../src/orchestration/createBackup.js";

const timestamp = "2026-07-24T12:00:00.000Z";

function createDestination(): {
	destination: BackupDestination;
	objects: Map<string, DestinationObject>;
	} {
	const objects = new Map<string, DestinationObject>();
	let generation_next = 1;
	const destination: BackupDestination = {
		async putObject(path_object, data_object, options_put = {}) {
			if (options_put.if_generation_match === 0 && objects.has(path_object)) {
				throw Object.assign(new Error("exists"), { code: 412 });
			}
			const metadata = {
				path: path_object,
				generation: generation_next++,
				size_bytes: data_object.byteLength,
				sha256: createHash("sha256").update(data_object).digest("hex"),
				updated_at: timestamp,
				metadata: options_put.metadata ?? {},
			};
			objects.set(path_object, metadata);
			return metadata;
		},
		async getObject() {
			return Buffer.alloc(0);
		},
		async statObject(path_object) {
			return objects.get(path_object) ?? null;
		},
		async deleteObject(path_object) {
			objects.delete(path_object);
		},
		async listObjects(prefix_object) {
			return [...objects.values()].filter((object_stored) =>
				object_stored.path.startsWith(prefix_object));
		},
	};
	return { destination, objects };
}

function createReceipts(started_at: string): {
	postgres: PostgresReceipt;
	clickhouse: ClickhouseReceipt;
	blob: BlobReceipt;
} {
	return {
		postgres: {
			provider: "postgres",
			object_path: "staging/postgres.dump",
			size_bytes: 1,
			sha256: "a".repeat(64),
			started_at,
			completed_at: started_at,
			verified_at: started_at,
			client_version: "17.5",
			server_version: "17.5",
		},
		clickhouse: {
			provider: "clickhouse",
			operation_id: "operation-1",
			database: "default",
			object_prefix: "staging/clickhouse",
			status: "BACKUP_CREATED",
			size_bytes: 1,
			started_at,
			completed_at: started_at,
			verified_at: started_at,
			server_version: "25.7",
		},
		blob: {
			provider: "gcs_inventory",
			inventory_path: "staging/blob.ndjson.gz",
			object_count: 1,
			size_bytes: 1,
			sha256: "b".repeat(64),
			started_at,
			completed_at: started_at,
			verified_at: started_at,
		},
	};
}

function createDrainedSnapshot(): QueueSnapshot {
	return {
		captured_at: "2026-07-24T12:00:02.000Z",
		pending_count: 0,
		failed_count: 0,
		queues: [],
	};
}

describe("coordinated backup", () => {
	it("runs the post-hook after a component failure and does not commit", async () => {
		const { destination, objects } = createDestination();
		const run_post_hook = vi.fn(async () => undefined);
		const receipts = createReceipts("2026-07-24T12:00:04.000Z");

		await expect(createBackup({
			destination,
			deployment_id: "prod",
			backup_id: "backup-1",
			allow_active_writes: false,
			consistency: {
				mode: "coordinated",
				run_pre_hook: async () => undefined,
				wait_for_queue_drain: async () => createDrainedSnapshot(),
				run_post_hook,
			},
			preflight: async () => undefined,
			backup_postgres: async () => {
				throw new Error("PostgreSQL unavailable");
			},
			backup_clickhouse: async () => receipts.clickhouse,
			backup_blob: async () => receipts.blob,
			tool_version: "0.1.0",
			source_revision: "abc123",
			required_secrets: [],
			now: () => new Date(timestamp),
		})).rejects.toThrow(/PostgreSQL unavailable/);

		expect(run_post_hook).toHaveBeenCalledOnce();
		expect([...objects.keys()].some((path_object) =>
			path_object.endsWith("/manifest.json"))).toBe(false);
		expect([...objects.keys()].some((path_object) =>
			path_object.startsWith("locks/"))).toBe(false);
	});

	it("rejects a non-empty snapshot before running components", async () => {
		const { destination } = createDestination();
		const backup_postgres = vi.fn(async () =>
			createReceipts(timestamp).postgres);

		await expect(createBackup({
			destination,
			deployment_id: "prod",
			backup_id: "backup-1",
			allow_active_writes: false,
			consistency: {
				mode: "coordinated",
				run_pre_hook: async () => undefined,
				wait_for_queue_drain: async () => ({
					...createDrainedSnapshot(),
					pending_count: 1,
				}),
				run_post_hook: async () => undefined,
			},
			preflight: async () => undefined,
			backup_postgres,
			backup_clickhouse: async () => createReceipts(timestamp).clickhouse,
			backup_blob: async () => createReceipts(timestamp).blob,
			tool_version: "0.1.0",
			source_revision: "abc123",
			required_secrets: [],
		})).rejects.toThrow(/queue.*not drained/i);

		expect(backup_postgres).not.toHaveBeenCalled();
	});
});
