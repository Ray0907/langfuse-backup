import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { gunzipSync } from "node:zlib";

import type { DestinationObject } from "../destination/types.js";
import type { BlobReceipt } from "../manifest/schema.js";

export interface BlobRestoreEntry {
	target_key: string;
	source_path: string;
	source_generation?: string;
	size_bytes: number;
	checksum: {
		algorithm: "sha256" | "md5" | "crc32c";
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

const crc32c_table = new Uint32Array(256).map((_, index_value) => {
	let checksum_value = index_value;
	for (let index_bit = 0; index_bit < 8; index_bit += 1) {
		checksum_value = (checksum_value & 1) === 1
			? 0x82f63b78 ^ (checksum_value >>> 1)
			: checksum_value >>> 1;
	}
	return checksum_value >>> 0;
});

function updateCrc32c(checksum_current: number, data_chunk: Buffer): number {
	let checksum_next = checksum_current;
	for (const byte_value of data_chunk) {
		checksum_next = (crc32c_table[(checksum_next ^ byte_value) & 0xff] ?? 0)
			^ (checksum_next >>> 8);
	}
	return checksum_next >>> 0;
}

function formatCrc32c(checksum_value: number): string {
	const data_checksum = Buffer.allocUnsafe(4);
	data_checksum.writeUInt32BE((~checksum_value) >>> 0);
	return data_checksum.toString("base64");
}

async function restoreObject(
	options: RestoreBlobStorageOptions,
	entry_restore: BlobRestoreEntry,
): Promise<DestinationObject> {
	const path_temporary = await mkdtemp(join(tmpdir(), "langfuse-blob-restore-"));
	const path_file = join(path_temporary, "object.bin");
	const hash_expected = entry_restore.checksum.algorithm === "crc32c"
		? undefined
		: createHash(entry_restore.checksum.algorithm);
	const hash_sha256 = createHash("sha256");
	let checksum_crc32c = 0xffffffff;
	let size_bytes = 0;
	const stream_hash = new Transform({
		transform(chunk_data: Buffer, _encoding, callback) {
			hash_expected?.update(chunk_data);
			checksum_crc32c = updateCrc32c(checksum_crc32c, chunk_data);
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
		const checksum_actual = hash_expected === undefined
			? formatCrc32c(checksum_crc32c)
			: hash_expected.digest("hex");
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

async function restoreBlobEntries(
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

export type BackupBlobReference = {
	provider: "gcs";
	path: string;
	generation: string;
} | {
	provider: "copy";
	path: string;
	generation: number;
};

export interface BackupBlobObject {
	data: Buffer;
	sha256?: string;
	md5_hash?: string;
	crc32c?: string;
}

export interface RestoreBlobJournalEntry {
	path: string;
	size_bytes: number;
	sha256: string;
	target_generation: number;
	source_path: string;
	source_generation?: string;
}

export interface RestoreBlobReceiptOptions {
	receipt: BlobReceipt;
	inventory_data: Buffer;
	read_backup_object: (
		reference: BackupBlobReference,
	) => Promise<BackupBlobObject>;
	stat_target_object: (path_object: string) => Promise<DestinationObject | null>;
	write_target_object: (
		path_object: string,
		data_object: Buffer,
		overwrite: boolean,
	) => Promise<DestinationObject>;
	read_journal: () => Promise<RestoreBlobJournalEntry[]>;
	append_journal: (entry_journal: RestoreBlobJournalEntry) => Promise<void>;
	overwrite?: boolean;
}

export interface BlobReceiptRestoreResult {
	object_count: number;
	restored_count: number;
	skipped_count: number;
	sha256_by_path: Record<string, string>;
}

interface GcsInventoryRecord {
	name: string;
	generation: string;
	size_bytes: number;
	md5_hash?: string;
	crc32c?: string;
	time_deleted?: string;
}

interface CopyInventoryRecord {
	source_key: string;
	size_bytes: number;
	destination_path: string;
	destination_generation: number;
	destination_sha256: string;
}

function parseInventoryLines(data_inventory: Buffer, receipt: BlobReceipt): unknown[] {
	if (data_inventory.byteLength !== receipt.size_bytes
		|| createHash("sha256").update(data_inventory).digest("hex") !== receipt.sha256) {
		throw new Error("Blob inventory size or checksum mismatch");
	}
	const text_inventory = gunzipSync(data_inventory).toString("utf8");
	const lines_inventory = text_inventory.split("\n").filter((line) => line !== "");
	if (lines_inventory.length !== receipt.object_count) {
		throw new Error("Blob inventory object count mismatch");
	}
	return lines_inventory.map((line_inventory) => JSON.parse(line_inventory) as unknown);
}

function getRecord(value_entry: unknown): Record<string, unknown> {
	if (value_entry === null || typeof value_entry !== "object") {
		throw new Error("Blob inventory entry must be an object");
	}
	return value_entry as Record<string, unknown>;
}

function getString(record_entry: Record<string, unknown>, name_field: string): string {
	const value_field = record_entry[name_field];
	if (typeof value_field !== "string" || value_field.length === 0) {
		throw new Error(`Blob inventory entry has invalid ${name_field}`);
	}
	return value_field;
}

function getSize(record_entry: Record<string, unknown>): number {
	const size_bytes = record_entry.size_bytes;
	if (!Number.isSafeInteger(size_bytes) || Number(size_bytes) < 0) {
		throw new Error("Blob inventory entry has invalid size_bytes");
	}
	return Number(size_bytes);
}

function parseGcsEntry(value_entry: unknown): GcsInventoryRecord {
	const record_entry = getRecord(value_entry);
	const value_md5 = record_entry.md5_hash;
	const value_crc32c = record_entry.crc32c;
	if (typeof value_md5 !== "string" && typeof value_crc32c !== "string") {
		throw new Error("GCS inventory entry has no supported checksum");
	}
	return {
		name: getString(record_entry, "name"),
		generation: getString(record_entry, "generation"),
		size_bytes: getSize(record_entry),
		...(typeof value_md5 === "string" ? { md5_hash: value_md5 } : {}),
		...(typeof value_crc32c === "string" ? { crc32c: value_crc32c } : {}),
		...(typeof record_entry.time_deleted === "string"
			? { time_deleted: record_entry.time_deleted }
			: {}),
	};
}

function parseCopyEntry(value_entry: unknown): CopyInventoryRecord {
	const record_entry = getRecord(value_entry);
	const generation = Number(record_entry.destination_generation);
	if (!Number.isSafeInteger(generation) || generation < 1) {
		throw new Error("Blob copy inventory has invalid destination_generation");
	}
	return {
		source_key: getString(record_entry, "source_key"),
		size_bytes: getSize(record_entry),
		destination_path: getString(record_entry, "destination_path"),
		destination_generation: generation,
		destination_sha256: getString(record_entry, "destination_sha256"),
	};
}

function createGcsEntries(values_inventory: unknown[]): BlobRestoreEntry[] {
	const names_live = new Set<string>();
	return values_inventory.map(parseGcsEntry)
		.filter((entry_inventory) => entry_inventory.time_deleted === undefined)
		.map((entry_inventory) => {
			if (names_live.has(entry_inventory.name)) {
				throw new Error(`Multiple live GCS generations for ${entry_inventory.name}`);
			}
			names_live.add(entry_inventory.name);
			const has_md5 = entry_inventory.md5_hash !== undefined;
			return {
				target_key: entry_inventory.name,
				source_path: entry_inventory.name,
				source_generation: entry_inventory.generation,
				size_bytes: entry_inventory.size_bytes,
				checksum: has_md5 ? {
					algorithm: "md5" as const,
					value: Buffer.from(entry_inventory.md5_hash!, "base64").toString("hex"),
				} : {
					algorithm: "crc32c" as const,
					value: entry_inventory.crc32c!,
				},
			};
		});
}

function createCopyEntries(values_inventory: unknown[]): BlobRestoreEntry[] {
	return values_inventory.map(parseCopyEntry).map((entry_inventory) => ({
		target_key: entry_inventory.source_key,
		source_path: entry_inventory.destination_path,
		source_generation: String(entry_inventory.destination_generation),
		size_bytes: entry_inventory.size_bytes,
		checksum: {
			algorithm: "sha256",
			value: entry_inventory.destination_sha256,
		},
	}));
}

function getReference(
	provider: BlobReceipt["provider"],
	entry_restore: BlobRestoreEntry,
): BackupBlobReference {
	if (provider === "gcs_inventory") {
		return {
			provider: "gcs",
			path: entry_restore.source_path,
			generation: entry_restore.source_generation!,
		};
	}
	return {
		provider: "copy",
		path: entry_restore.source_path,
		generation: Number(entry_restore.source_generation),
	};
}

async function restoreBlobReceipt(
	options: RestoreBlobReceiptOptions,
): Promise<BlobReceiptRestoreResult> {
	const values_inventory = parseInventoryLines(
		options.inventory_data,
		options.receipt,
	);
	const entries_restore = options.receipt.provider === "gcs_inventory"
		? createGcsEntries(values_inventory)
		: createCopyEntries(values_inventory);
	const entries_journal = await options.read_journal();
	const paths_journal = new Set(entries_journal.map((entry) => entry.path));
	const completed = Object.fromEntries(entries_journal.map((entry) => [
		entry.path,
		{
			size_bytes: entry.size_bytes,
			sha256: entry.sha256,
			target_generation: entry.target_generation,
			source_path: entry.source_path,
			...(entry.source_generation === undefined
				? {}
				: { source_generation: entry.source_generation }),
		},
	]));
	const result_restore = await restoreBlobEntries({
		backup_id: options.receipt.inventory_path,
		entries: entries_restore,
		open_source: async (entry_restore) => {
			const object_backup = await options.read_backup_object(
				getReference(options.receipt.provider, entry_restore),
			);
			return (async function* readObject() {
				yield object_backup.data;
			})();
		},
		stat_target: options.stat_target_object,
		upload_target: async (upload) => options.write_target_object(
			upload.target_key,
			await readFile(upload.path_file),
			upload.overwrite,
		),
		read_journal: async () => ({
			backup_id: options.receipt.inventory_path,
			completed,
		}),
		write_journal: async (journal) => {
			for (const [path_object, entry_journal] of Object.entries(journal.completed)) {
				if (paths_journal.has(path_object)) {
					continue;
				}
				await options.append_journal({ path: path_object, ...entry_journal });
				paths_journal.add(path_object);
			}
		},
		...(options.overwrite === undefined ? {} : { overwrite: options.overwrite }),
	});
	return {
		object_count: entries_restore.length,
		restored_count: result_restore.restored_count,
		skipped_count: result_restore.skipped_count,
		sha256_by_path: Object.fromEntries(
			Object.entries(result_restore.journal.completed)
				.map(([path_object, entry_journal]) => [
					path_object,
					entry_journal.sha256,
				]),
		),
	};
}

export function restoreBlobStorage(
	options: RestoreBlobStorageOptions,
): Promise<BlobRestoreResult>;
export function restoreBlobStorage(
	options: RestoreBlobReceiptOptions,
): Promise<BlobReceiptRestoreResult>;
export function restoreBlobStorage(
	options: RestoreBlobStorageOptions | RestoreBlobReceiptOptions,
): Promise<BlobRestoreResult | BlobReceiptRestoreResult> {
	return "receipt" in options
		? restoreBlobReceipt(options)
		: restoreBlobEntries(options);
}
