import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type {
	BackupDestination,
	DestinationObject,
} from "../../src/destination/types.js";
import type {
	BlobReceipt,
	ClickhouseReceipt,
	PostgresReceipt,
} from "../../src/manifest/schema.js";
import {
	createBackup,
	type BackupStage,
} from "../../src/orchestration/createBackup.js";

function createDestination(): BackupDestination {
	const objects = new Map<string, {
		data: Buffer;
		metadata: DestinationObject;
	}>();
	let generation_next = 1;
	return {
		async putObject(path_object, data_object, options_put = {}) {
			const metadata = {
				path: path_object,
				generation: generation_next++,
				size_bytes: data_object.byteLength,
				sha256: createHash("sha256").update(data_object).digest("hex"),
				updated_at: "2026-07-24T12:00:08.000Z",
				metadata: options_put.metadata ?? {},
			};
			objects.set(path_object, { data: Buffer.from(data_object), metadata });
			return metadata;
		},
		async getObject(path_object) {
			const object_stored = objects.get(path_object);
			if (object_stored === undefined) {
				throw Object.assign(new Error("missing"), { code: 404 });
			}
			return object_stored.data;
		},
		async statObject(path_object) {
			return objects.get(path_object)?.metadata ?? null;
		},
		async deleteObject(path_object) {
			objects.delete(path_object);
		},
		async listObjects(prefix_object) {
			return [...objects.values()]
				.map((object_stored) => object_stored.metadata)
				.filter((metadata) => metadata.path.startsWith(prefix_object));
		},
	};
}

const receipt_postgres: PostgresReceipt = {
	provider: "postgres",
	object_path: "staging/postgres.dump",
	size_bytes: 1,
	sha256: "a".repeat(64),
	started_at: "2026-07-24T12:00:04.000Z",
	completed_at: "2026-07-24T12:00:05.000Z",
	verified_at: "2026-07-24T12:00:05.000Z",
	client_version: "17.5",
	server_version: "17.5",
};

const receipt_clickhouse: ClickhouseReceipt = {
	provider: "clickhouse",
	operation_id: "operation-1",
	database: "default",
	object_prefix: "staging/clickhouse",
	status: "BACKUP_CREATED",
	size_bytes: 1,
	started_at: "2026-07-24T12:00:05.000Z",
	completed_at: "2026-07-24T12:00:06.000Z",
	verified_at: "2026-07-24T12:00:06.000Z",
	server_version: "25.7",
};

const receipt_blob: BlobReceipt = {
	provider: "gcs_inventory",
	inventory_path: "staging/blob.ndjson.gz",
	object_count: 1,
	size_bytes: 1,
	sha256: "b".repeat(64),
	started_at: "2026-07-24T12:00:06.000Z",
	completed_at: "2026-07-24T12:00:07.000Z",
	verified_at: "2026-07-24T12:00:07.000Z",
};

describe("coordinated backup integration", () => {
	it("commits all receipts after the queue-drain boundary", async () => {
		const stages_seen: BackupStage[] = [];
		const times = [
			"2026-07-24T12:00:00.000Z",
			"2026-07-24T12:00:03.000Z",
			"2026-07-24T12:00:08.000Z",
		];
		let index_time = 0;

		const result_backup = await createBackup({
			destination: createDestination(),
			deployment_id: "prod",
			backup_id: "backup-1",
			allow_active_writes: false,
			consistency: {
				mode: "coordinated",
				run_pre_hook: async () => undefined,
				wait_for_queue_drain: async () => ({
					captured_at: "2026-07-24T12:00:02.000Z",
					pending_count: 0,
					failed_count: 0,
					queues: [],
				}),
				run_post_hook: async () => undefined,
			},
			preflight: async () => undefined,
			backup_postgres: async () => receipt_postgres,
			backup_clickhouse: async () => receipt_clickhouse,
			backup_blob: async () => receipt_blob,
			tool_version: "0.1.0",
			source_revision: "abc123",
			required_secrets: [],
			on_stage: (stage_backup) => {
				stages_seen.push(stage_backup);
			},
			now: () => new Date(
				times[index_time++] ?? "2026-07-24T12:00:08.000Z",
			),
		});

		expect(stages_seen).toEqual([
			"lock",
			"preflight",
			"pre_hook",
			"drain",
			"boundary",
			"postgres",
			"clickhouse",
			"blob",
			"verify",
			"manifest",
			"post_hook",
			"unlock",
		]);
		expect(result_backup.manifest.consistency).toMatchObject({
			mode: "coordinated",
			queue_drained_at: "2026-07-24T12:00:02.000Z",
			boundary_at: "2026-07-24T12:00:03.000Z",
		});
		expect(Date.parse(result_backup.manifest.consistency.boundary_at))
			.toBeLessThan(Date.parse(receipt_postgres.started_at));
		expect(result_backup.manifest.components).toEqual({
			postgres: receipt_postgres,
			clickhouse: receipt_clickhouse,
			blob: receipt_blob,
		});
	});
});
