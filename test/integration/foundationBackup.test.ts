import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type {
	BackupDestination,
	DestinationObject,
} from "../../src/destination/types.js";
import { readManifest } from "../../src/manifest/readManifest.js";
import type {
	BlobReceipt,
	ClickhouseReceipt,
	PostgresReceipt,
} from "../../src/manifest/schema.js";
import { createBackup } from "../../src/orchestration/createBackup.js";

const timestamp = "2026-07-24T12:00:00.000Z";

function createDestination(): BackupDestination {
	const objects = new Map<string, { data: Buffer; metadata: DestinationObject }>();
	return {
		async putObject(path_object, data_object) {
			const sha256 = createHash("sha256").update(data_object).digest("hex");
			const metadata = {
				path: path_object,
				generation: 1,
				size_bytes: data_object.length,
				sha256,
				updated_at: timestamp,
				metadata: {},
			};
			objects.set(path_object, { data: Buffer.from(data_object), metadata });
			return metadata;
		},
		async getObject(path_object) {
			const object_stored = objects.get(path_object);
			if (object_stored === undefined) {
				throw Object.assign(new Error("notFound"), { code: 404 });
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

describe("foundation backup integration", () => {
	it("commits one manifest with verified PostgreSQL and ClickHouse receipts", async () => {
		const destination = createDestination();
		const receipt_postgres: PostgresReceipt = {
			provider: "postgres",
			object_path: "staging/postgres.dump",
			size_bytes: 4,
			sha256: createHash("sha256").update("dump").digest("hex"),
			started_at: timestamp,
			completed_at: timestamp,
			verified_at: timestamp,
			client_version: "17.5",
			server_version: "17.5",
		};
		const receipt_clickhouse: ClickhouseReceipt = {
			provider: "clickhouse",
			operation_id: "operation-1",
			database: "default",
			object_prefix: "staging/clickhouse",
			status: "BACKUP_CREATED",
			size_bytes: 4,
			started_at: timestamp,
			completed_at: timestamp,
			verified_at: timestamp,
			server_version: "25.7",
		};
		const receipt_blob: BlobReceipt = {
			provider: "gcs_inventory",
			inventory_path: "staging/blob.ndjson.gz",
			object_count: 1,
			size_bytes: 4,
			sha256: createHash("sha256").update("blob").digest("hex"),
			started_at: timestamp,
			completed_at: timestamp,
			verified_at: timestamp,
		};

		await destination.putObject(receipt_postgres.object_path, Buffer.from("dump"));
		await destination.putObject(receipt_blob.inventory_path, Buffer.from("blob"));
		const result_backup = await createBackup({
			destination,
			deployment_id: "integration",
			backup_id: "backup-1",
			allow_active_writes: true,
			preflight: async () => undefined,
			backup_postgres: async () => receipt_postgres,
			backup_clickhouse: async () => receipt_clickhouse,
			backup_blob: async () => receipt_blob,
			tool_version: "0.1.0",
			source_revision: "integration",
			required_secrets: [],
			now: () => new Date(timestamp),
		});

		const path_manifest = "deployments/integration/backups/backup-1/manifest.json";
		const data_manifest = await destination.getObject(path_manifest);
		const committed = readManifest(data_manifest.toString("utf8"));
		expect(committed.backup_id).toBe(result_backup.manifest.backup_id);
		expect(committed.components.postgres.verified_at).toBe(timestamp);
		expect(committed.components.clickhouse.status).toBe("BACKUP_CREATED");
	});
});
