import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import type { DestinationObject } from "../../src/destination/types.js";
import {
	writeGcsInventory,
	type GcsInventorySource,
} from "../../src/blob/gcsInventory.js";

function createSource(options: {
	versioning_enabled: boolean;
	pages: Record<string, {
		objects: Array<Record<string, unknown>>;
		next_page_token?: string;
	}>;
}): { source: GcsInventorySource; calls: string[] } {
	const calls: string[] = [];
	let active_calls = 0;

	return {
		calls,
		source: {
			async isVersioningEnabled() {
				return options.versioning_enabled;
			},
			async listObjectVersions(prefix_object, page_token) {
				active_calls += 1;
				if (active_calls > 1) {
					throw new Error("inventory pages were requested concurrently");
				}
				const key_page = `${prefix_object}:${page_token ?? "first"}`;
				calls.push(key_page);
				const page_result = options.pages[key_page] ?? { objects: [] };
				active_calls -= 1;
				return page_result;
			},
		},
	};
}

interface UploadCapture {
	upload_file: (
		path_object: string,
		path_file: string,
		metadata: Record<string, string>,
	) => Promise<DestinationObject>;
	getCompressed: () => Buffer;
}

function createUploadCapture(): UploadCapture {
	let data_compressed = Buffer.alloc(0);

	return {
		async upload_file(path_object, path_file, metadata) {
			data_compressed = await readFile(path_file);
			const sha256 = createHash("sha256").update(data_compressed).digest("hex");
			expect(metadata.sha256).toBe(sha256);
			return {
				path: path_object,
				generation: 1,
				size_bytes: data_compressed.byteLength,
				sha256,
				updated_at: "2026-07-24T12:00:00.000Z",
				metadata,
			};
		},
		getCompressed: () => data_compressed,
	};
}

describe("writeGcsInventory", () => {
	it("requires object versioning or an explicit immutable-bucket guarantee", async () => {
		const { source } = createSource({ versioning_enabled: false, pages: {} });
		const upload_capture = createUploadCapture();

		await expect(writeGcsInventory({
			source,
			prefixes: ["events/"],
			immutable_bucket: false,
			inventory_path: "staging/blob.ndjson.gz",
			upload_file: upload_capture.upload_file,
		})).rejects.toThrow(/versioning.*immutable/i);
	});

	it("streams every paginated generation with checksums and deletion time", async () => {
		const { source, calls } = createSource({
			versioning_enabled: true,
			pages: {
				"events/:first": {
					objects: [{
						name: "events/a.json",
						generation: "2",
						size: "5",
						md5_hash: "md5-a2",
						crc32c: "crc-a2",
						updated_at: "2026-07-24T11:00:00.000Z",
					}],
					next_page_token: "page-2",
				},
				"events/:page-2": {
					objects: [{
						name: "events/a.json",
						generation: "1",
						size: "4",
						md5_hash: "md5-a1",
						crc32c: "crc-a1",
						updated_at: "2026-07-24T10:00:00.000Z",
						time_deleted: "2026-07-24T10:30:00.000Z",
					}],
				},
				"media/:first": {
					objects: [{
						name: "media/image.png",
						generation: "7",
						size: "8",
						crc32c: "crc-media",
						updated_at: "2026-07-24T11:30:00.000Z",
					}],
				},
			},
		});
		const upload_capture = createUploadCapture();

		const receipt = await writeGcsInventory({
			source,
			prefixes: ["events/", "media/"],
			immutable_bucket: false,
			inventory_path: "staging/blob.ndjson.gz",
			upload_file: upload_capture.upload_file,
			now: () => new Date("2026-07-24T12:00:00.000Z"),
		});

		const lines_inventory = gunzipSync(upload_capture.getCompressed())
			.toString("utf8")
			.trim()
			.split("\n")
			.map((line_inventory) => JSON.parse(line_inventory) as Record<string, unknown>);
		expect(calls).toEqual([
			"events/:first",
			"events/:page-2",
			"media/:first",
		]);
		expect(lines_inventory).toHaveLength(3);
		expect(lines_inventory[1]).toMatchObject({
			name: "events/a.json",
			generation: "1",
			time_deleted: "2026-07-24T10:30:00.000Z",
		});
		expect(receipt.object_count).toBe(3);
		expect(receipt.sha256).toMatch(/^[a-f0-9]{64}$/);
	});

	it("writes a valid empty gzip inventory", async () => {
		const { source } = createSource({
			versioning_enabled: true,
			pages: {},
		});
		const upload_capture = createUploadCapture();

		const receipt = await writeGcsInventory({
			source,
			prefixes: ["events/"],
			immutable_bucket: false,
			inventory_path: "staging/empty.ndjson.gz",
			upload_file: upload_capture.upload_file,
		});

		expect(gunzipSync(upload_capture.getCompressed()).byteLength).toBe(0);
		expect(receipt.object_count).toBe(0);
	});
});
