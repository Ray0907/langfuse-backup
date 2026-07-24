import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import type { DestinationObject } from "../../src/destination/types.js";
import { restoreBlobStorage } from "../../src/restore/restoreBlobStorage.js";

describe("blob restore integration", () => {
	it("round-trips raw events and media from a copied-object inventory", async () => {
		const objects_backup = new Map<string, Buffer>([
			["staging/blob/events/raw.json", Buffer.from("raw-event")],
			["staging/blob/media/image.png", Buffer.from("image-data")],
		]);
		const entries_inventory = [...objects_backup.entries()].map(
			([path_backup, data_object], index_object) => ({
				source_key: path_backup.replace("staging/blob/", ""),
				source_etag: `opaque-${index_object}`,
				size_bytes: data_object.byteLength,
				destination_path: path_backup,
				destination_generation: index_object + 1,
				destination_sha256: createHash("sha256")
					.update(data_object)
					.digest("hex"),
			}),
		);
		const data_inventory = gzipSync(
			`${entries_inventory.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
		);
		const objects_target = new Map<string, Buffer>();

		const result_restore = await restoreBlobStorage({
			receipt: {
				provider: "s3_copy",
				inventory_path: "staging/blob.ndjson.gz",
				object_count: 2,
				size_bytes: data_inventory.byteLength,
				sha256: createHash("sha256").update(data_inventory).digest("hex"),
				started_at: "2026-07-24T12:00:00.000Z",
				completed_at: "2026-07-24T12:00:00.000Z",
				verified_at: "2026-07-24T12:00:00.000Z",
			},
			inventory_data: data_inventory,
			read_backup_object: async (reference) => ({
				data: objects_backup.get(reference.path) ?? Buffer.alloc(0),
			}),
			stat_target_object: async () => null,
			write_target_object: async (path_object, data_object) => {
				objects_target.set(path_object, Buffer.from(data_object));
				const metadata: DestinationObject = {
					path: path_object,
					generation: objects_target.size,
					size_bytes: data_object.byteLength,
					sha256: createHash("sha256").update(data_object).digest("hex"),
					updated_at: "2026-07-24T12:00:00.000Z",
					metadata: {},
				};
				return metadata;
			},
			read_journal: async () => [],
			append_journal: async () => undefined,
		});

		expect(objects_target).toEqual(new Map([
			["events/raw.json", Buffer.from("raw-event")],
			["media/image.png", Buffer.from("image-data")],
		]));
		expect(result_restore.object_count).toBe(2);
	});
});
