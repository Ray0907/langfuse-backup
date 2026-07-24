import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
	copyBlobPrefixes,
	type BlobCopyUpload,
	type S3BlobSource,
} from "../../src/blob/copyBlobPrefix.js";
import type { DestinationObject } from "../../src/destination/types.js";

function createDestinationObject(
	upload: BlobCopyUpload,
	data_object: Buffer,
	generation: number,
): DestinationObject {
	return {
		path: upload.path_object,
		generation,
		size_bytes: data_object.byteLength,
		sha256: createHash("sha256").update(data_object).digest("hex"),
		updated_at: "2026-07-24T12:00:00.000Z",
		metadata: upload.metadata,
	};
}

describe("MinIO-compatible blob backup integration", () => {
	it("copies raw events and media while omitting batch exports", async () => {
		const objects_source = new Map<string, Buffer>([
			["events/raw-event.json", Buffer.from("{\"event\":\"seeded\"}")],
			["media/screenshot.png", Buffer.from("seeded-media")],
			["batch_exports/export.json", Buffer.from("not-recoverable-input")],
		]);
		const source: S3BlobSource = {
			async listPage(request_page) {
				return {
					objects: [...objects_source.entries()]
						.filter(([key_object]) => key_object.startsWith(request_page.prefix))
						.map(([key_object, data_object]) => ({
							key: key_object,
							etag: `"opaque-${key_object}-2"`,
							size_bytes: data_object.byteLength,
						})),
				};
			},
			async openObject(key_object) {
				const data_object = objects_source.get(key_object);
				if (data_object === undefined) {
					throw new Error(`Missing seeded object ${key_object}`);
				}
				return (async function* readObject() {
					yield data_object;
				})();
			},
		};
		const objects_destination = new Map<string, {
			data: Buffer;
			metadata: DestinationObject;
		}>();

		const receipt = await copyBlobPrefixes({
			source,
			destination_prefix: "staging/blob-copy",
			inventory_path: "staging/blob-copy.ndjson.gz",
			stat_object: async (path_object) =>
				objects_destination.get(path_object)?.metadata ?? null,
			upload_file: async (upload) => {
				const data_object = await readFile(upload.path_file);
				const metadata = createDestinationObject(
					upload,
					data_object,
					objects_destination.size + 1,
				);
				objects_destination.set(upload.path_object, {
					data: data_object,
					metadata,
				});
				return metadata;
			},
			now: () => new Date("2026-07-24T12:00:00.000Z"),
		});

		const paths_copied = [...objects_destination.keys()];
		expect(paths_copied).toContain("staging/blob-copy/events/raw-event.json");
		expect(paths_copied).toContain("staging/blob-copy/media/screenshot.png");
		expect(paths_copied.some((path_object) =>
			path_object.includes("batch_exports"))).toBe(false);

		const inventory = objects_destination.get(receipt.inventory_path);
		expect(inventory).toBeDefined();
		const entries_inventory = gunzipSync(inventory!.data)
			.toString("utf8")
			.trim()
			.split("\n")
			.map((line_entry) => JSON.parse(line_entry) as {
				source_key: string;
				destination_generation: number;
				destination_sha256: string;
			});
		expect(entries_inventory.map((entry) => entry.source_key).sort()).toEqual([
			"events/raw-event.json",
			"media/screenshot.png",
		]);
		expect(entries_inventory.every((entry) =>
			entry.destination_generation > 0
			&& /^[a-f0-9]{64}$/.test(entry.destination_sha256))).toBe(true);
		expect(receipt.object_count).toBe(2);
	});
});
