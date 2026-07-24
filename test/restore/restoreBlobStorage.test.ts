import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

import { describe, expect, it, vi } from "vitest";

import type { DestinationObject } from "../../src/destination/types.js";
import type { BlobReceipt } from "../../src/manifest/schema.js";
import {
	restoreBlobStorage,
	type BackupBlobReference,
	type RestoreBlobJournalEntry,
} from "../../src/restore/restoreBlobStorage.js";

function createInventory(lines_inventory: object[]): Buffer {
	return gzipSync(lines_inventory
		.map((entry_inventory) => JSON.stringify(entry_inventory))
		.join("\n")
		.concat("\n"));
}

function createReceipt(
	provider: BlobReceipt["provider"],
	data_inventory: Buffer,
): BlobReceipt {
	return {
		provider,
		inventory_path: "backup/blob.ndjson.gz",
		object_count: 1,
		size_bytes: data_inventory.byteLength,
		sha256: createHash("sha256").update(data_inventory).digest("hex"),
		started_at: "2026-07-24T12:00:00.000Z",
		completed_at: "2026-07-24T12:00:00.000Z",
		verified_at: "2026-07-24T12:00:00.000Z",
	};
}

function createObject(path_object: string, data_object: Buffer): DestinationObject {
	return {
		path: path_object,
		generation: 1,
		size_bytes: data_object.byteLength,
		sha256: createHash("sha256").update(data_object).digest("hex"),
		updated_at: "2026-07-24T12:00:00.000Z",
		metadata: {},
	};
}

describe("restoreBlobStorage", () => {
	it("restores a specific live GCS generation and journals it", async () => {
		const data_object = Buffer.from("123456789");
		const crc32c = "4waSgw==";
		const data_inventory = createInventory([{
			name: "events/raw.json",
			generation: "42",
			size_bytes: data_object.byteLength,
			crc32c,
			updated_at: "2026-07-24T12:00:00.000Z",
		}]);
		const references_seen: BackupBlobReference[] = [];
		const journal_seen: RestoreBlobJournalEntry[] = [];

		const result_restore = await restoreBlobStorage({
			receipt: createReceipt("gcs_inventory", data_inventory),
			inventory_data: data_inventory,
			read_backup_object: async (reference) => {
				references_seen.push(reference);
				return { data: data_object, crc32c };
			},
			stat_target_object: async () => null,
			write_target_object: async (path_object, data_target) =>
				createObject(path_object, data_target),
			read_journal: async () => [],
			append_journal: async (entry_journal) => {
				journal_seen.push(entry_journal);
			},
		});

		expect(references_seen).toEqual([{
			provider: "gcs",
			path: "events/raw.json",
			generation: "42",
		}]);
		expect(journal_seen).toHaveLength(1);
		expect(result_restore).toMatchObject({ object_count: 1 });
	});

	it("restores an S3-copy object using its destination SHA-256", async () => {
		const data_object = Buffer.from("copied-object");
		const sha256 = createHash("sha256").update(data_object).digest("hex");
		const data_inventory = createInventory([{
			source_key: "media/image.png",
			source_etag: "\"opaque-etag-2\"",
			size_bytes: data_object.byteLength,
			destination_path: "staging/blob/media/image.png",
			destination_generation: 7,
			destination_sha256: sha256,
		}]);

		const result_restore = await restoreBlobStorage({
			receipt: createReceipt("s3_copy", data_inventory),
			inventory_data: data_inventory,
			read_backup_object: async (reference) => {
				expect(reference).toMatchObject({
					provider: "copy",
					path: "staging/blob/media/image.png",
					generation: 7,
				});
				return { data: data_object, sha256 };
			},
			stat_target_object: async () => null,
			write_target_object: async (path_object, data_target) =>
				createObject(path_object, data_target),
			read_journal: async () => [],
			append_journal: async () => undefined,
		});

		expect(result_restore.sha256_by_path["media/image.png"]).toBe(sha256);
	});

	it("rejects checksum mismatches and pre-existing target objects", async () => {
		const data_object = Buffer.from("payload");
		const data_inventory = createInventory([{
			source_key: "events/raw.json",
			source_etag: "etag",
			size_bytes: data_object.byteLength,
			destination_path: "staging/blob/events/raw.json",
			destination_generation: 1,
			destination_sha256: "a".repeat(64),
		}]);
		const receipt = createReceipt("s3_copy", data_inventory);
		const write_target_object = vi.fn(async (path_object: string, data: Buffer) =>
			createObject(path_object, data));

		await expect(restoreBlobStorage({
			receipt,
			inventory_data: data_inventory,
			read_backup_object: async () => ({ data: data_object }),
			stat_target_object: async () => null,
			write_target_object,
			read_journal: async () => [],
			append_journal: async () => undefined,
		})).rejects.toThrow(/checksum.*mismatch/i);
		expect(write_target_object).not.toHaveBeenCalled();

		await expect(restoreBlobStorage({
			receipt,
			inventory_data: data_inventory,
			read_backup_object: async () => ({ data: data_object }),
			stat_target_object: async (path_object) =>
				createObject(path_object, data_object),
			write_target_object,
			read_journal: async () => [],
			append_journal: async () => undefined,
		})).rejects.toThrow(/target.*already exists/i);
	});

	it("resumes only journaled, verified objects after interruption", async () => {
		const objects = [
			["events/first.json", Buffer.from("first")],
			["media/second.png", Buffer.from("second")],
		] as const;
		const entries = objects.map(([path_object, data_object], index_object) => ({
			source_key: path_object,
			source_etag: `etag-${index_object}`,
			size_bytes: data_object.byteLength,
			destination_path: `staging/blob/${path_object}`,
			destination_generation: index_object + 1,
			destination_sha256: createHash("sha256").update(data_object).digest("hex"),
		}));
		const data_inventory = createInventory(entries);
		const receipt = {
			...createReceipt("s3_copy", data_inventory),
			object_count: 2,
		};
		const objects_target = new Map<string, DestinationObject>();
		const journal: RestoreBlobJournalEntry[] = [];
		let should_interrupt = true;

		const run_restore = async () => restoreBlobStorage({
			receipt,
			inventory_data: data_inventory,
			read_backup_object: async (reference) => {
				if (reference.path.includes("second") && should_interrupt) {
					throw new Error("interrupted");
				}
				const data_object = objects.find(([path_object]) =>
					reference.path.endsWith(path_object))?.[1];
				if (data_object === undefined) {
					throw new Error("missing fixture");
				}
				return { data: data_object };
			},
			stat_target_object: async (path_object) =>
				objects_target.get(path_object) ?? null,
			write_target_object: async (path_object, data_object) => {
				const metadata = createObject(path_object, data_object);
				objects_target.set(path_object, metadata);
				return metadata;
			},
			read_journal: async () => journal,
			append_journal: async (entry_journal) => {
				journal.push(entry_journal);
			},
		});

		await expect(run_restore()).rejects.toThrow(/interrupted/i);
		expect(journal.map((entry) => entry.path)).toEqual(["events/first.json"]);

		should_interrupt = false;
		const result_restore = await run_restore();
		expect(result_restore.object_count).toBe(2);
		expect(journal.map((entry) => entry.path)).toEqual([
			"events/first.json",
			"media/second.png",
		]);
	});
});
