import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
	writeGcsInventory,
	type GcsInventorySource,
} from "../../src/blob/gcsInventory.js";

describe("GCS inventory integration", () => {
	it("writes every seeded generation exactly once with a verified checksum", async () => {
		const entries_seeded: Array<Record<string, unknown>> = Array.from(
			{ length: 25 },
			(_, index) => ({
			name: `events/raw-${Math.floor(index / 2)}.json`,
			generation: String(index + 1),
			size: String(index + 10),
			crc32c: `crc-${index}`,
			updated_at: "2026-07-24T12:00:00.000Z",
			}),
		);
		const source: GcsInventorySource = {
			async isVersioningEnabled() {
				return true;
			},
			async listObjectVersions(_prefix_object, page_token) {
				const index_start = Number(page_token ?? 0);
				const entries_page = entries_seeded.slice(
					index_start,
					index_start + 4,
				);
				const index_next = index_start + entries_page.length;
				return {
					objects: entries_page,
					...(index_next >= entries_seeded.length
						? {}
						: { next_page_token: String(index_next) }),
				};
			},
		};
		let checksum_uploaded = "";

		const receipt = await writeGcsInventory({
			source,
			prefixes: ["events/"],
			immutable_bucket: false,
			inventory_path: "staging/blob.ndjson.gz",
			upload_file: async (path_object, path_file) => {
				const data_inventory = await readFile(path_file);
				checksum_uploaded = createHash("sha256").update(data_inventory).digest("hex");
				return {
					path: path_object,
					generation: 1,
					size_bytes: data_inventory.byteLength,
					sha256: checksum_uploaded,
					updated_at: "2026-07-24T12:01:00.000Z",
					metadata: {},
				};
			},
		});

		expect(receipt.object_count).toBe(entries_seeded.length);
		expect(receipt.sha256).toBe(checksum_uploaded);
	});
});
