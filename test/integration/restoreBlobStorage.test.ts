import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
	restoreBlobStorage,
	type BlobRestoreEntry,
	type BlobRestoreJournal,
} from "../../src/restore/restoreBlobStorage.js";
import type { DestinationObject } from "../../src/destination/types.js";

describe("blob restore integration", () => {
	it("restores raw events and media with persisted checksum journals", async () => {
		const path_test = await mkdtemp(join(tmpdir(), "langfuse-restore-blob-"));
		const path_journal = join(path_test, "journal.json");
		const objects_source = new Map([
			["backup/events/raw.json", Buffer.from("raw-event")],
			["backup/media/image.png", Buffer.from("media")],
		]);
		const objects_target = new Map<string, { data: Buffer; metadata: DestinationObject }>();
		const entries: BlobRestoreEntry[] = [...objects_source.entries()].map(
			([path_source, data_source]) => ({
				target_key: path_source.replace(/^backup\//, ""),
				source_path: path_source,
				source_generation: "1",
				size_bytes: data_source.byteLength,
				checksum: {
					algorithm: "sha256",
					value: createHash("sha256").update(data_source).digest("hex"),
				},
			}),
		);

		try {
			await restoreBlobStorage({
				backup_id: "backup-1",
				entries,
				open_source: async (entry_restore) => (async function* readSource() {
					yield objects_source.get(entry_restore.source_path) ?? Buffer.alloc(0);
				})(),
				stat_target: async (target_key) =>
					objects_target.get(target_key)?.metadata ?? null,
				upload_target: async (upload) => {
					const data_target = await readFile(upload.path_file);
					const metadata: DestinationObject = {
						path: upload.target_key,
						generation: 1,
						size_bytes: data_target.byteLength,
						sha256: createHash("sha256").update(data_target).digest("hex"),
						updated_at: "2026-07-24T12:00:00.000Z",
						metadata: {},
					};
					objects_target.set(upload.target_key, { data: data_target, metadata });
					return metadata;
				},
				read_journal: async () => {
					try {
						return JSON.parse(
							await readFile(path_journal, "utf8"),
						) as BlobRestoreJournal;
					} catch {
						return null;
					}
				},
				write_journal: async (journal) => {
					await writeFile(path_journal, `${JSON.stringify(journal)}\n`, {
						mode: 0o600,
					});
				},
			});

			for (const entry_restore of entries) {
				const data_source = objects_source.get(entry_restore.source_path);
				const data_target = objects_target.get(entry_restore.target_key)?.data;
				expect(data_target).toEqual(data_source);
			}
			const journal = JSON.parse(
				await readFile(path_journal, "utf8"),
			) as BlobRestoreJournal;
			expect(Object.keys(journal.completed)).toHaveLength(2);
		} finally {
			await rm(path_test, { recursive: true, force: true });
		}
	});
});
