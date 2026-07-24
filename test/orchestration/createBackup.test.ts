import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type {
	BackupDestination,
	DestinationObject,
	PutObjectOptions,
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

interface MemoryDestination {
	destination: BackupDestination;
	objects: Map<string, { data: Buffer; metadata: DestinationObject }>;
}

function createMemoryDestination(): MemoryDestination {
	const objects = new Map<string, { data: Buffer; metadata: DestinationObject }>();
	let generation_next = 1;

	const destination: BackupDestination = {
		async putObject(path_object, data_object, options_put: PutObjectOptions = {}) {
			const object_existing = objects.get(path_object);
			if (options_put.if_generation_match === 0 && object_existing !== undefined) {
				throw Object.assign(new Error("exists"), { code: 412 });
			}
			if (
				options_put.if_generation_match !== undefined
				&& options_put.if_generation_match !== 0
				&& object_existing?.metadata.generation !== options_put.if_generation_match
			) {
				throw Object.assign(new Error("changed"), { code: 412 });
			}
			const metadata: DestinationObject = {
				path: path_object,
				generation: generation_next,
				size_bytes: data_object.byteLength,
				sha256: createHash("sha256").update(data_object).digest("hex"),
				updated_at: "2026-07-24T12:00:00.000Z",
				metadata: options_put.metadata ?? {},
			};
			generation_next += 1;
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
		async deleteObject(path_object, generation) {
			if (objects.get(path_object)?.metadata.generation !== generation) {
				throw Object.assign(new Error("changed"), { code: 412 });
			}
			objects.delete(path_object);
		},
		async listObjects(prefix_object) {
			return [...objects.values()]
				.map((object_stored) => object_stored.metadata)
				.filter((metadata) => metadata.path.startsWith(prefix_object));
		},
	};

	return { destination, objects };
}

const receipt_postgres: PostgresReceipt = {
	provider: "postgres",
	object_path: "staging/postgres.dump",
	size_bytes: 10,
	sha256: "a".repeat(64),
	started_at: "2026-07-24T12:00:00.000Z",
	completed_at: "2026-07-24T12:00:01.000Z",
	verified_at: "2026-07-24T12:00:02.000Z",
	client_version: "17.5",
	server_version: "17.5",
};

const receipt_clickhouse: ClickhouseReceipt = {
	provider: "clickhouse",
	operation_id: "operation-1",
	database: "default",
	object_prefix: "clickhouse/operation-1",
	status: "BACKUP_CREATED",
	size_bytes: 20,
	started_at: "2026-07-24T12:00:00.000Z",
	completed_at: "2026-07-24T12:00:01.000Z",
	verified_at: "2026-07-24T12:00:02.000Z",
	server_version: "25.7.1.1",
};

const receipt_blob: BlobReceipt = {
	provider: "gcs_inventory",
	inventory_path: "staging/blob.ndjson.gz",
	object_count: 2,
	size_bytes: 30,
	sha256: "b".repeat(64),
	started_at: "2026-07-24T12:00:00.000Z",
	completed_at: "2026-07-24T12:00:01.000Z",
	verified_at: "2026-07-24T12:00:02.000Z",
};

function getManifestPaths(
	objects: Map<string, { data: Buffer; metadata: DestinationObject }>,
): string[] {
	return [...objects.keys()].filter((path_object) =>
		path_object.endsWith("/manifest.json"));
}

describe("createBackup", () => {
	it("orders components and writes the manifest last", async () => {
		const { destination, objects } = createMemoryDestination();
		const stages_seen: BackupStage[] = [];

		const result_backup = await createBackup({
			destination,
			deployment_id: "prod",
			backup_id: "backup-1",
			allow_active_writes: true,
			preflight: async () => undefined,
			backup_postgres: async () => receipt_postgres,
			backup_clickhouse: async () => receipt_clickhouse,
			backup_blob: async () => receipt_blob,
			on_stage: (stage_backup) => {
				stages_seen.push(stage_backup);
			},
			now: () => new Date("2026-07-24T12:00:03.000Z"),
			tool_version: "0.1.0",
			source_revision: "abc123",
			required_secrets: ["POSTGRES_URL"],
		});

		expect(stages_seen).toEqual([
			"lock",
			"preflight",
			"postgres",
			"clickhouse",
			"blob",
			"verify",
			"manifest",
			"unlock",
		]);
		expect(result_backup.manifest.consistency.mode).toBe("online");
		expect(getManifestPaths(objects)).toEqual([result_backup.manifest_path]);
	});

	it.each([
		"preflight",
		"postgres",
		"clickhouse",
		"blob",
		"verify",
	] as const)("does not commit a manifest when %s fails", async (stage_failure) => {
		const { destination, objects } = createMemoryDestination();

		await expect(createBackup({
			destination,
			deployment_id: "prod",
			backup_id: "backup-1",
			allow_active_writes: true,
			preflight: async () => undefined,
			backup_postgres: async () => receipt_postgres,
			backup_clickhouse: async () => receipt_clickhouse,
			backup_blob: async () => receipt_blob,
			on_stage: (stage_backup) => {
				if (stage_backup === stage_failure) {
					throw new Error(`Injected ${stage_failure} failure`);
				}
			},
			now: () => new Date("2026-07-24T12:00:03.000Z"),
			tool_version: "0.1.0",
			source_revision: "abc123",
			required_secrets: [],
		})).rejects.toThrow(`Injected ${stage_failure} failure`);

		expect(getManifestPaths(objects)).toEqual([]);
		expect([...objects.keys()].some((path_object) =>
			path_object.startsWith("locks/"))).toBe(false);
	});

	it("requires explicit acceptance of online consistency", async () => {
		const { destination } = createMemoryDestination();

		await expect(createBackup({
			destination,
			deployment_id: "prod",
			backup_id: "backup-1",
			allow_active_writes: false,
			preflight: async () => undefined,
			backup_postgres: async () => receipt_postgres,
			backup_clickhouse: async () => receipt_clickhouse,
			backup_blob: async () => receipt_blob,
			tool_version: "0.1.0",
			source_revision: "abc123",
			required_secrets: [],
		})).rejects.toThrow(/allow.active.writes/i);
	});
});
