import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { DestinationObject } from "../destination/types.js";
import type { BlobReceipt } from "../manifest/schema.js";
import { withCompressedInventory } from "./writeInventory.js";

export interface S3BlobObject {
	key: string;
	etag: string;
	size_bytes: number;
}

export interface S3BlobPage {
	objects: S3BlobObject[];
	next_page_token?: string;
}

export interface S3BlobSource {
	listPage: (request_page: {
		prefix: string;
		page_token?: string;
	}) => Promise<S3BlobPage>;
	openObject: (key_object: string) => Promise<AsyncIterable<Uint8Array>>;
}

export interface BlobCopyUpload {
	path_object: string;
	path_file: string;
	size_bytes: number;
	sha256: string;
	metadata: Record<string, string>;
}

interface CopiedBlobEntry {
	source_key: string;
	source_etag: string;
	size_bytes: number;
	destination_path: string;
	destination_generation: number;
	destination_sha256: string;
}

interface DownloadedObject {
	path_file: string;
	size_bytes: number;
	sha256: string;
	cleanup: () => Promise<void>;
}

export interface CopyBlobPrefixesOptions {
	source: S3BlobSource;
	prefixes?: string[];
	destination_prefix: string;
	inventory_path: string;
	concurrency?: number;
	max_attempts?: number;
	stat_object: (path_object: string) => Promise<DestinationObject | null>;
	upload_file: (upload: BlobCopyUpload) => Promise<DestinationObject>;
	sleep?: (duration_ms: number) => Promise<void>;
	now?: () => Date;
}

function sleepDefault(duration_ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, duration_ms));
}

async function downloadObject(
	source: S3BlobSource,
	object_source: S3BlobObject,
	max_attempts: number,
	sleep: (duration_ms: number) => Promise<void>,
): Promise<DownloadedObject> {
	let error_last: unknown;

	for (let attempt = 1; attempt <= max_attempts; attempt += 1) {
		const path_temporary = await mkdtemp(join(tmpdir(), "langfuse-s3-copy-"));
		const path_file = join(path_temporary, "object.bin");
		const hash_object = createHash("sha256");
		let size_bytes = 0;
		const stream_hash = new Transform({
			transform(chunk_data: Buffer, _encoding, callback) {
				hash_object.update(chunk_data);
				size_bytes += chunk_data.byteLength;
				callback(null, chunk_data);
			},
		});

		try {
			const stream_source = await source.openObject(object_source.key);
			await pipeline(
				Readable.from(stream_source),
				stream_hash,
				createWriteStream(path_file, { mode: 0o600 }),
			);
			if (size_bytes !== object_source.size_bytes) {
				throw new Error(`S3 object size mismatch for ${object_source.key}`);
			}
			return {
				path_file,
				size_bytes,
				sha256: hash_object.digest("hex"),
				cleanup: async () => rm(path_temporary, { recursive: true, force: true }),
			};
		} catch (error) {
			error_last = error;
			await rm(path_temporary, { recursive: true, force: true });
			if (attempt < max_attempts) {
				await sleep(Math.min(10 * (2 ** (attempt - 1)), 250));
			}
		}
	}

	throw error_last;
}

function createCopiedEntry(
	object_source: S3BlobObject,
	path_destination: string,
	object_destination: DestinationObject,
): CopiedBlobEntry {
	return {
		source_key: object_source.key,
		source_etag: object_source.etag,
		size_bytes: object_source.size_bytes,
		destination_path: path_destination,
		destination_generation: object_destination.generation,
		destination_sha256: object_destination.sha256,
	};
}

async function copyObject(
	options: CopyBlobPrefixesOptions,
	object_source: S3BlobObject,
	max_attempts: number,
	sleep: (duration_ms: number) => Promise<void>,
): Promise<CopiedBlobEntry> {
	const prefix_destination = options.destination_prefix.replace(/\/$/, "");
	const path_destination = `${prefix_destination}/${object_source.key}`;
	const object_existing = await options.stat_object(path_destination);
	if (object_existing !== null) {
		if (object_existing.size_bytes !== object_source.size_bytes
			|| object_existing.metadata.source_etag !== object_source.etag) {
			throw new Error(`Immutable destination mismatch for ${path_destination}`);
		}
		return createCopiedEntry(object_source, path_destination, object_existing);
	}

	const object_downloaded = await downloadObject(
		options.source,
		object_source,
		max_attempts,
		sleep,
	);
	try {
		const object_uploaded = await options.upload_file({
			path_object: path_destination,
			path_file: object_downloaded.path_file,
			size_bytes: object_downloaded.size_bytes,
			sha256: object_downloaded.sha256,
			metadata: {
				source_key: object_source.key,
				source_etag: object_source.etag,
				sha256: object_downloaded.sha256,
			},
		});
		if (object_uploaded.size_bytes !== object_downloaded.size_bytes
			|| object_uploaded.sha256 !== object_downloaded.sha256) {
			throw new Error(`Copied object verification failed for ${path_destination}`);
		}
		return createCopiedEntry(object_source, path_destination, object_uploaded);
	} finally {
		await object_downloaded.cleanup();
	}
}

async function* copyObjects(
	options: CopyBlobPrefixesOptions,
): AsyncGenerator<CopiedBlobEntry> {
	const concurrency = options.concurrency ?? 4;
	if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
		throw new Error("Blob copy concurrency must be a positive integer");
	}
	const max_attempts = options.max_attempts ?? 3;
	const sleep = options.sleep ?? sleepDefault;

	for (const prefix_source of options.prefixes ?? ["events/", "media/"]) {
		let page_token: string | undefined;
		do {
			const page_source = await options.source.listPage({
				prefix: prefix_source,
				...(page_token === undefined ? {} : { page_token }),
			});
			const objects_matching = page_source.objects.filter((object_source) =>
				object_source.key.startsWith(prefix_source));
			for (let index_start = 0; index_start < objects_matching.length;
				index_start += concurrency) {
				const chunk_objects = objects_matching.slice(
					index_start,
					index_start + concurrency,
				);
				const entries_copied = await Promise.all(chunk_objects.map(
					async (object_source) => copyObject(
						options,
						object_source,
						max_attempts,
						sleep,
					),
				));
				for (const entry_copied of entries_copied) {
					yield entry_copied;
				}
			}
			page_token = page_source.next_page_token;
		} while (page_token !== undefined);
	}
}

export async function copyBlobPrefixes(
	options: CopyBlobPrefixesOptions,
): Promise<BlobReceipt> {
	const get_now = options.now ?? (() => new Date());
	const started_at = get_now().toISOString();
	const result_inventory = await withCompressedInventory(
		copyObjects(options),
		async (path_file, metadata_inventory) => options.upload_file({
			path_object: options.inventory_path,
			path_file,
			size_bytes: metadata_inventory.size_bytes,
			sha256: metadata_inventory.sha256,
			metadata: {
				sha256: metadata_inventory.sha256,
				format: "ndjson+gzip",
			},
		}),
	);
	const object_inventory = result_inventory.result_upload;
	if (object_inventory.size_bytes !== result_inventory.metadata.size_bytes
		|| object_inventory.sha256 !== result_inventory.metadata.sha256) {
		throw new Error("Blob-copy inventory verification failed");
	}
	const completed_at = get_now().toISOString();

	return {
		provider: "s3_copy",
		inventory_path: options.inventory_path,
		object_count: result_inventory.metadata.object_count,
		size_bytes: result_inventory.metadata.size_bytes,
		sha256: result_inventory.metadata.sha256,
		started_at,
		completed_at,
		verified_at: get_now().toISOString(),
	};
}
