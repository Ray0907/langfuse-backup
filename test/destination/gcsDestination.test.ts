import { describe, expect, it } from "vitest";

import {
	GcsDestination,
	type GcsBucketLike,
} from "../../src/destination/gcsDestination.js";

interface StoredObject {
	data: Buffer;
	generation: number;
	metadata: Record<string, string>;
}

function createMemoryBucket(): GcsBucketLike {
	const objects_stored = new Map<string, StoredObject>();

	return {
		file(path_object) {
			return {
				async save(data_object, options_save) {
					const object_existing = objects_stored.get(path_object);
					const expected_generation =
						options_save.preconditionOpts?.ifGenerationMatch;

					if (expected_generation === 0 && object_existing !== undefined) {
						throw Object.assign(new Error("conditionNotMet"), { code: 412 });
					}

					if (
						expected_generation !== undefined
						&& expected_generation !== 0
						&& object_existing?.generation !== expected_generation
					) {
						throw Object.assign(new Error("conditionNotMet"), { code: 412 });
					}

					objects_stored.set(path_object, {
						data: Buffer.from(data_object),
						generation: (object_existing?.generation ?? 0) + 1,
						metadata: options_save.metadata?.metadata ?? {},
					});
				},
				async download() {
					const object_stored = objects_stored.get(path_object);
					if (object_stored === undefined) {
						throw Object.assign(new Error("notFound"), { code: 404 });
					}
					return [object_stored.data];
				},
				async getMetadata() {
					const object_stored = objects_stored.get(path_object);
					if (object_stored === undefined) {
						throw Object.assign(new Error("notFound"), { code: 404 });
					}
					return [{
						generation: String(object_stored.generation),
						size: String(object_stored.data.byteLength),
						metadata: object_stored.metadata,
					}];
				},
				async delete(options_delete) {
					const object_stored = objects_stored.get(path_object);
					if (
						object_stored === undefined
						|| (
							options_delete?.ifGenerationMatch !== undefined
							&& options_delete.ifGenerationMatch !== object_stored.generation
						)
					) {
						throw Object.assign(new Error("conditionNotMet"), { code: 412 });
					}
					objects_stored.delete(path_object);
				},
			};
		},
		async getFiles(options_list) {
			const files_found = [...objects_stored.keys()]
				.filter((path_object) => path_object.startsWith(options_list.prefix ?? ""))
				.map((path_object) => ({ name: path_object }));
			return [files_found];
		},
	};
}

describe("GcsDestination", () => {
	it("prevents concurrent conditional object creation", async () => {
		const destination = new GcsDestination({
			bucket: createMemoryBucket(),
			prefix: "backups",
		});

		await destination.writeJson("locks/source.json", { owner_id: "first" }, {
			if_generation_match: 0,
		});

		await expect(destination.writeJson("locks/source.json", { owner_id: "second" }, {
			if_generation_match: 0,
		})).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
	});

	it("writes staging data and lists only committed manifests", async () => {
		const destination = new GcsDestination({
			bucket: createMemoryBucket(),
			prefix: "backups",
		});

		await destination.writeBuffer(
			"staging/incomplete/postgres.dump",
			Buffer.from("dump"),
		);
		await destination.writeJson("recovery/backup-1/manifest.json", {
			backup_id: "backup-1",
		});

		await expect(destination.listCommittedManifestPaths()).resolves.toEqual([
			"recovery/backup-1/manifest.json",
		]);
	});
});

