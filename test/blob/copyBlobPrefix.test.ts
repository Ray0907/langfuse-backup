import { Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
	copyBlobPrefixes,
	type BlobCopyUpload,
	type S3BlobSource,
} from "../../src/blob/copyBlobPrefix.js";
import type { DestinationObject } from "../../src/destination/types.js";

function createMetadata(
	path_object: string,
	upload: BlobCopyUpload,
	generation = 1,
): DestinationObject {
	return {
		path: path_object,
		generation,
		size_bytes: upload.size_bytes,
		sha256: upload.sha256,
		updated_at: "2026-07-24T12:00:00.000Z",
		metadata: upload.metadata,
	};
}

describe("copyBlobPrefixes", () => {
	it("copies required prefixes and treats multipart ETags as opaque evidence", async () => {
		const prefixes_seen: string[] = [];
		const uploads_seen: BlobCopyUpload[] = [];
		const source: S3BlobSource = {
			async listPage(request_page) {
				prefixes_seen.push(request_page.prefix);
				return request_page.prefix === "events/"
					? {
						objects: [{
							key: "events/raw.json",
							size_bytes: 7,
							etag: "\"multipart-etag-2\"",
						}],
					}
					: { objects: [] };
			},
			async openObject() {
				return Readable.from([Buffer.from("payload")]);
			},
		};

		const receipt = await copyBlobPrefixes({
			source,
			destination_prefix: "staging/blob-copy",
			inventory_path: "staging/blob-copy.ndjson.gz",
			stat_object: async () => null,
			upload_file: async (upload) => {
				uploads_seen.push(upload);
				return createMetadata(upload.path_object, upload);
			},
			now: () => new Date("2026-07-24T12:00:00.000Z"),
		});

		expect(prefixes_seen).toEqual(["events/", "media/"]);
		expect(uploads_seen[0]?.metadata.source_etag).toBe("\"multipart-etag-2\"");
		expect(uploads_seen[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
		expect(uploads_seen[0]?.sha256).not.toContain("multipart-etag");
		expect(receipt.provider).toBe("s3_copy");
		expect(receipt.object_count).toBe(1);
	});

	it("retries a bounded transient source failure", async () => {
		let attempts_open = 0;
		const source: S3BlobSource = {
			async listPage() {
				return {
					objects: [{
						key: "events/raw.json",
						size_bytes: 7,
						etag: "etag",
					}],
				};
			},
			async openObject() {
				attempts_open += 1;
				if (attempts_open === 1) {
					throw new Error("temporary source failure");
				}
				return Readable.from([Buffer.from("payload")]);
			},
		};

		await copyBlobPrefixes({
			source,
			destination_prefix: "staging/blob-copy",
			inventory_path: "staging/blob-copy.ndjson.gz",
			stat_object: async () => null,
			upload_file: async (upload) => createMetadata(upload.path_object, upload),
			max_attempts: 2,
			sleep: async () => undefined,
		});

		expect(attempts_open).toBe(2);
	});

	it("refuses to overwrite a mismatched immutable destination object", async () => {
		const upload_file = vi.fn(async (upload: BlobCopyUpload) =>
			createMetadata(upload.path_object, upload));
		const source: S3BlobSource = {
			async listPage() {
				return {
					objects: [{
						key: "media/image.png",
						size_bytes: 7,
						etag: "source-etag",
					}],
				};
			},
			async openObject() {
				return Readable.from([Buffer.from("payload")]);
			},
		};

		await expect(copyBlobPrefixes({
			source,
			destination_prefix: "staging/blob-copy",
			inventory_path: "staging/blob-copy.ndjson.gz",
			stat_object: async (path_object) => ({
				path: path_object,
				generation: 4,
				size_bytes: 7,
				sha256: "a".repeat(64),
				updated_at: "2026-07-24T12:00:00.000Z",
				metadata: { source_etag: "different-etag" },
			}),
			upload_file,
		})).rejects.toThrow(/immutable.*mismatch/i);

		expect(upload_file).not.toHaveBeenCalled();
	});

	it("does not upload the inventory when a copy is interrupted", async () => {
		const uploads_seen: BlobCopyUpload[] = [];
		const source: S3BlobSource = {
			async listPage(request_page) {
				return request_page.prefix === "events/"
					? {
						objects: [{
							key: "events/raw.json",
							size_bytes: 7,
							etag: "etag",
						}],
					}
					: { objects: [] };
			},
			async openObject() {
				throw new Error("interrupted");
			},
		};

		await expect(copyBlobPrefixes({
			source,
			destination_prefix: "staging/blob-copy",
			inventory_path: "staging/blob-copy.ndjson.gz",
			stat_object: async () => null,
			upload_file: async (upload) => {
				uploads_seen.push(upload);
				return createMetadata(upload.path_object, upload);
			},
			max_attempts: 1,
		})).rejects.toThrow(/interrupted/i);

		expect(uploads_seen.some((upload) =>
			upload.path_object.endsWith(".ndjson.gz"))).toBe(false);
	});
});
