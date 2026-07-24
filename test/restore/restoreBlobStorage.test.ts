import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import {
	restoreBlobStorage,
	type BlobRestoreEntry,
	type BlobRestoreJournal,
} from "../../src/restore/restoreBlobStorage.js";
import type { DestinationObject } from "../../src/destination/types.js";

function getSha256(value_data: string): string {
	return createHash("sha256").update(value_data).digest("hex");
}

function createEntry(
	target_key: string,
	value_data: string,
	options: Partial<BlobRestoreEntry> = {},
): BlobRestoreEntry {
	return {
		target_key,
		source_path: `backup/${target_key}`,
		source_generation: "10",
		size_bytes: Buffer.byteLength(value_data),
		checksum: {
			algorithm: "sha256",
			value: getSha256(value_data),
		},
		...options,
	};
}

function createDestinationObject(
	path_object: string,
	data_object: Buffer,
): DestinationObject {
	return {
		path: path_object,
		generation: 1,
		size_bytes: data_object.byteLength,
		sha256: createHash("sha256").update(data_object).digest("hex"),
		updated_at: "2026-07-24T12:00:00.000Z",
		metadata: {},
	};
}

function getCompleted(journal: BlobRestoreJournal | null): Record<string, unknown> {
	return journal?.completed ?? {};
}

describe("restoreBlobStorage", () => {
	it("restores exact GCS generations and MinIO-copy objects", async () => {
		const entries = [
			createEntry("events/raw.json", "event", { source_generation: "123" }),
			createEntry("media/image.png", "media", {
				source_path: "backups/blob-copy/media/image.png",
				source_generation: "77",
			}),
		];
		const source_requests: Array<{ path: string; generation?: string }> = [];
		const data_by_target: Record<string, string> = {
			"events/raw.json": "event",
			"media/image.png": "media",
		};
		let journal_saved: BlobRestoreJournal | null = null;

		const result_restore = await restoreBlobStorage({
			backup_id: "backup-1",
			entries,
			open_source: async (entry_restore) => {
				source_requests.push({
					path: entry_restore.source_path,
					...(entry_restore.source_generation === undefined
						? {}
						: { generation: entry_restore.source_generation }),
				});
				return (async function* readSource() {
					yield Buffer.from(data_by_target[entry_restore.target_key] ?? "");
				})();
			},
			stat_target: async () => null,
			upload_target: async (upload) => createDestinationObject(
				upload.target_key,
				await readFile(upload.path_file),
			),
			read_journal: async () => journal_saved,
			write_journal: async (journal) => {
				journal_saved = structuredClone(journal);
			},
		});

		expect(source_requests).toEqual([
			{ path: "backup/events/raw.json", generation: "123" },
			{ path: "backups/blob-copy/media/image.png", generation: "77" },
		]);
		expect(result_restore.restored_count).toBe(2);
		expect(Object.keys(getCompleted(journal_saved))).toHaveLength(2);
	});

	it("rejects checksum mismatches before upload", async () => {
		const upload_target = vi.fn();

		await expect(restoreBlobStorage({
			backup_id: "backup-1",
			entries: [createEntry("events/raw.json", "expected")],
			open_source: async () => (async function* readSource() {
				yield Buffer.from("tampered");
			})(),
			stat_target: async () => null,
			upload_target,
			read_journal: async () => null,
			write_journal: async () => undefined,
		})).rejects.toThrow(/checksum.*mismatch/i);

		expect(upload_target).not.toHaveBeenCalled();
	});

	it("refuses pre-existing target objects without overwrite mode", async () => {
		const entry_restore = createEntry("events/raw.json", "event");

		await expect(restoreBlobStorage({
			backup_id: "backup-1",
			entries: [entry_restore],
			open_source: async () => (async function* readSource() {
				yield Buffer.from("event");
			})(),
			stat_target: async () => createDestinationObject(
				entry_restore.target_key,
				Buffer.from("existing"),
			),
			upload_target: async () => {
				throw new Error("upload must not run");
			},
			read_journal: async () => null,
			write_journal: async () => undefined,
		})).rejects.toThrow(/target.*already exists/i);
	});

	it("journals each verified object and resumes after interruption", async () => {
		const entries = [
			createEntry("events/first.json", "first"),
			createEntry("events/second.json", "second"),
		];
		const objects_target = new Map<string, DestinationObject>();
		let journal_saved: BlobRestoreJournal | null = null;
		let interrupt_second = true;
		const open_source = async (entry_restore: BlobRestoreEntry) =>
			(async function* readSource() {
				if (entry_restore.target_key.endsWith("second.json") && interrupt_second) {
					throw new Error("source interrupted");
				}
				yield Buffer.from(entry_restore.target_key.endsWith("first.json")
					? "first"
					: "second");
			})();
		const upload_target = vi.fn(async (upload: {
			target_key: string;
			path_file: string;
		}) => {
			const object_target = createDestinationObject(
				upload.target_key,
				await readFile(upload.path_file),
			);
			objects_target.set(upload.target_key, object_target);
			return object_target;
		});
		const options_base = {
			backup_id: "backup-1",
			entries,
			open_source,
			stat_target: async (target_key: string) => objects_target.get(target_key) ?? null,
			upload_target,
			read_journal: async () => journal_saved,
			write_journal: async (journal: BlobRestoreJournal) => {
				journal_saved = structuredClone(journal);
			},
		};

		await expect(restoreBlobStorage(options_base)).rejects.toThrow(/interrupted/i);
		expect(Object.keys(getCompleted(journal_saved))).toEqual(["events/first.json"]);

		interrupt_second = false;
		const result_resume = await restoreBlobStorage(options_base);
		expect(result_resume).toMatchObject({ restored_count: 1, skipped_count: 1 });
		expect(upload_target).toHaveBeenCalledTimes(2);
	});
});
