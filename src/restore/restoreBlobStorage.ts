import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { DestinationObject } from "../destination/types.js";

export interface BlobRestoreEntry {
	target_key: string;
	source_path: string;
	source_generation?: string;
	size_bytes: number;
	checksum: {
		algorithm: "sha256" | "md5";
		value: string;
	};
}

export interface BlobRestoreJournalEntry {
	size_bytes: number;
	sha256: string;
	target_generation: number;
	source_path: string;
	source_generation?: string;
}

export interface BlobRestoreJournal {
	backup_id: string;
	completed: Record<string, BlobRestoreJournalEntry>;
}

export interface BlobTargetUpload {
	target_key: string;
	path_file: string;
	size_bytes: number;
	sha256: string;
	overwrite: boolean;
}

export interface RestoreBlobStorageOptions {
	backup_id: string;
	entries: Iterable<BlobRestoreEntry>;
	open_source: (entry_restore: BlobRestoreEntry) => Promise<AsyncIterable<Uint8Array>>;
	stat_target: (target_key: string) => Promise<DestinationObject | null>;
	upload_target: (upload: BlobTargetUpload) => Promise<DestinationObject>;
	read_journal: () => Promise<BlobRestoreJournal | null>;
	write_journal: (journal: BlobRestoreJournal) => Promise<void>;
	overwrite?: boolean;
}

export interface BlobRestoreResult {
	restored_count: number;
	skipped_count: number;
	journal: BlobRestoreJournal;
}

async function restoreObject(
	options: RestoreBlobStorageOptions,
	entry_restore: BlobRestoreEntry,
): Promise<DestinationObject> {
	const path_temporary = await mkdtemp(join(tmpdir(), "langfuse-blob-restore-"));
	const path_file = join(path_temporary, "object.bin");
	const hash_expected = createHash(entry_restore.checksum.algorithm);
	const hash_sha256 = createHash("sha256");
	let size_bytes = 0;
	const stream_hash = new Transform({
		transform(chunk_data: Buffer, _encoding, callback) {
			hash_expected.update(chunk_data);
			hash_sha256.update(chunk_data);
			size_bytes += chunk_data.byteLength;
			callback(null, chunk_data);
		},
	});

	try {
		const stream_source = await options.open_source(entry_restore);
		await pipeline(
			Readable.from(stream_source),
			stream_hash,
			createWriteStream(path_file, { mode: 0o600 }),
		);
		if (size_bytes !== entry_restore.size_bytes) {
			throw new Error(`Blob size mismatch for ${entry_restore.target_key}`);
		}
		const checksum_actual = hash_expected.digest("hex");
		if (checksum_actual !== entry_restore.checksum.value) {
			throw new Error(`Blob checksum mismatch for ${entry_restore.target_key}`);
		}
		const sha256 = hash_sha256.digest("hex");
		const object_target = await options.upload_target({
			target_key: entry_restore.target_key,
			path_file,
			size_bytes,
			sha256,
			overwrite: options.overwrite === true,
		});
		if (object_target.size_bytes !== size_bytes || object_target.sha256 !== sha256) {
			throw new Error(`Blob target verification failed for ${entry_restore.target_key}`);
		}
		return object_target;
	} finally {
		await rm(path_temporary, { recursive: true, force: true });
	}
}

function createJournalEntry(
	entry_restore: BlobRestoreEntry,
	object_target: DestinationObject,
): BlobRestoreJournalEntry {
	return {
		size_bytes: object_target.size_bytes,
		sha256: object_target.sha256,
		target_generation: object_target.generation,
		source_path: entry_restore.source_path,
		...(entry_restore.source_generation === undefined
			? {}
			: { source_generation: entry_restore.source_generation }),
	};
}

export async function restoreBlobStorage(
	options: RestoreBlobStorageOptions,
): Promise<BlobRestoreResult> {
	const journal_existing = await options.read_journal();
	if (journal_existing !== null && journal_existing.backup_id !== options.backup_id) {
		throw new Error("Blob restore journal belongs to a different backup");
	}
	const journal: BlobRestoreJournal = journal_existing ?? {
		backup_id: options.backup_id,
		completed: {},
	};
	let restored_count = 0;
	let skipped_count = 0;

	for (const entry_restore of options.entries) {
		const journal_entry = journal.completed[entry_restore.target_key];
		const object_existing = await options.stat_target(entry_restore.target_key);
		if (journal_entry !== undefined) {
			if (object_existing === null
				|| object_existing.size_bytes !== journal_entry.size_bytes
				|| object_existing.sha256 !== journal_entry.sha256) {
				throw new Error(
					`Journaled blob target mismatch for ${entry_restore.target_key}`,
				);
			}
			skipped_count += 1;
			continue;
		}
		if (object_existing !== null && options.overwrite !== true) {
			throw new Error(`Target object already exists: ${entry_restore.target_key}`);
		}

		const object_target = await restoreObject(options, entry_restore);
		journal.completed[entry_restore.target_key] = createJournalEntry(
			entry_restore,
			object_target,
		);
		await options.write_journal(journal);
		restored_count += 1;
	}

	return { restored_count, skipped_count, journal };
}
