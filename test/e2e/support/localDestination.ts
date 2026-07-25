import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";

import type {
	BackupDestination,
	DestinationObject,
	PutObjectOptions,
} from "../../../src/destination/types.js";

interface StoredObject {
	generation: number;
	updated_at: string;
	metadata: Record<string, string>;
}

function getSha256(data_object: Buffer): string {
	return createHash("sha256").update(data_object).digest("hex");
}

export class LocalDestination implements BackupDestination {
	private generation_next = 1;
	private readonly objects = new Map<string, StoredObject>();

	public constructor(private readonly path_root: string) {}

	public async putObject(
		path_object: string,
		data_object: Buffer,
		options: PutObjectOptions = {},
	): Promise<DestinationObject> {
		if (options.if_generation_match === 0 && this.objects.has(path_object)) {
			throw new Error(`Precondition failed for ${path_object}`);
		}
		const path_file = this.getPath(path_object);
		await mkdir(resolve(path_file, ".."), { recursive: true });
		await writeFile(path_file, data_object, { mode: 0o600 });
		const object_stored = {
			generation: this.generation_next,
			updated_at: new Date().toISOString(),
			metadata: { ...options.metadata },
		};
		this.generation_next += 1;
		this.objects.set(path_object, object_stored);
		return this.describe(path_object, data_object, object_stored);
	}

	public async getObject(path_object: string): Promise<Buffer> {
		if (!this.objects.has(path_object)) {
			throw new Error(`Object not found: ${path_object}`);
		}
		return readFile(this.getPath(path_object));
	}

	public async statObject(path_object: string): Promise<DestinationObject | null> {
		const object_stored = this.objects.get(path_object);
		if (object_stored === undefined) {
			return null;
		}
		return this.describe(
			path_object,
			await readFile(this.getPath(path_object)),
			object_stored,
		);
	}

	public async deleteObject(path_object: string, generation: number): Promise<void> {
		const object_stored = this.objects.get(path_object);
		if (object_stored?.generation !== generation) {
			throw new Error(`Generation mismatch for ${path_object}`);
		}
		await rm(this.getPath(path_object));
		this.objects.delete(path_object);
	}

	public async listObjects(prefix_object: string): Promise<DestinationObject[]> {
		const paths_object = [...this.objects.keys()]
			.filter((path_object) => path_object.startsWith(prefix_object))
			.sort();
		return Promise.all(paths_object.map(async (path_object) =>
			this.statObject(path_object) as Promise<DestinationObject>));
	}

	private getPath(path_object: string): string {
		const path_file = resolve(this.path_root, path_object);
		const path_prefix = `${resolve(this.path_root)}${sep}`;
		if (!path_file.startsWith(path_prefix)) {
			throw new Error(`Unsafe destination path: ${path_object}`);
		}
		return path_file;
	}

	private describe(
		path_object: string,
		data_object: Buffer,
		object_stored: StoredObject,
	): DestinationObject {
		return {
			path: path_object,
			generation: object_stored.generation,
			size_bytes: data_object.byteLength,
			sha256: getSha256(data_object),
			updated_at: object_stored.updated_at,
			metadata: object_stored.metadata,
		};
	}
}
