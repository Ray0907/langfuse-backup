import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

import type { BlobInventoryEntry } from "./types.js";

export interface CompressedInventoryMetadata {
	object_count: number;
	size_bytes: number;
	sha256: string;
}

export async function withCompressedInventory<ResultUpload>(
	entries_inventory: AsyncIterable<BlobInventoryEntry>,
	upload_file: (
		path_file: string,
		metadata_inventory: CompressedInventoryMetadata,
	) => Promise<ResultUpload>,
): Promise<{
	metadata: CompressedInventoryMetadata;
	result_upload: ResultUpload;
}> {
	const path_temporary = await mkdtemp(join(tmpdir(), "langfuse-blob-inventory-"));
	const path_inventory = join(path_temporary, "inventory.ndjson.gz");
	const hash_sha256 = createHash("sha256");
	let object_count = 0;
	let size_bytes = 0;

	async function* getLines(): AsyncGenerator<Buffer> {
		for await (const entry_inventory of entries_inventory) {
			object_count += 1;
			yield Buffer.from(`${JSON.stringify(entry_inventory)}\n`);
		}
	}

	const stream_hash = new Transform({
		transform(chunk_data: Buffer, _encoding, callback) {
			hash_sha256.update(chunk_data);
			size_bytes += chunk_data.byteLength;
			callback(null, chunk_data);
		},
	});

	try {
		await pipeline(
			Readable.from(getLines()),
			createGzip(),
			stream_hash,
			createWriteStream(path_inventory, { mode: 0o600 }),
		);
		const metadata = {
			object_count,
			size_bytes,
			sha256: hash_sha256.digest("hex"),
		};
		const result_upload = await upload_file(path_inventory, metadata);
		return { metadata, result_upload };
	} finally {
		await rm(path_temporary, { recursive: true, force: true });
	}
}

