import { describe, expect, it } from "vitest";

import {
	GcsDestination,
	type GcsBucketLike,
	type GcsFileLike,
} from "../../src/destination/gcsDestination.js";

interface StoredObject {
	data: Buffer;
	generation: number;
	metadata: Record<string, string>;
	updated_at: string;
}

function createMemoryBucket(): GcsBucketLike {
	const objects_stored = new Map<string, StoredObject>();

	function getFile(path_object: string): GcsFileLike {
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
					metadata: options_save.metadata.metadata,
					updated_at: "2026-07-24T10:00:00.000Z",
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
					name: path_object,
					generation: String(object_stored.generation),
					size: String(object_stored.data.byteLength),
					updated: object_stored.updated_at,
					metadata: object_stored.metadata,
				}];
			},
			async delete(options_delete) {
				const object_stored = objects_stored.get(path_object);
				const expected_generation =
					options_delete?.preconditionOpts?.ifGenerationMatch;
				if (
					object_stored === undefined
					|| (
						expected_generation !== undefined
						&& object_stored.generation !== expected_generation
					)
				) {
					throw Object.assign(new Error("conditionNotMet"), { code: 412 });
				}
				objects_stored.delete(path_object);
			},
		};
	}

	return {
		file: getFile,
		async getFiles(options_list) {
			const files_found = [...objects_stored.keys()]
				.filter((path_object) => path_object.startsWith(options_list.prefix ?? ""))
				.map((path_object) => getFile(path_object));
			return [files_found];
		},
	};
}

describe("GcsDestination", () => {
	it("prevents concurrent conditional object creation", async () => {
		const destination = new GcsDestination(createMemoryBucket());

		await destination.putObject("locks/source.json", Buffer.from("first"), {
			if_generation_match: 0,
		});

		await expect(destination.putObject(
			"locks/source.json",
			Buffer.from("second"),
			{ if_generation_match: 0 },
		)).rejects.toMatchObject({ code: 412 });
	});

	it("writes staging data and lists only committed manifests", async () => {
		const destination = new GcsDestination(createMemoryBucket());

		await destination.putObject(
			"staging/incomplete/postgres.dump",
			Buffer.from("dump"),
		);
		await destination.putObject(
			"recovery/backup-1/manifest.json",
			Buffer.from("{}"),
		);

		await expect(destination.listCommittedManifests("recovery/")).resolves.toEqual([
			"recovery/backup-1/manifest.json",
		]);
	});
});

