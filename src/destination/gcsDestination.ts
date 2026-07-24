import { createHash } from "node:crypto";

import { Storage, type StorageOptions } from "@google-cloud/storage";

import type {
	BackupDestination,
	DestinationObject,
	PutObjectOptions,
} from "./types.js";

interface GcsMetadata {
	name?: string;
	generation?: string | number;
	size?: string | number;
	updated?: string;
	metadata?: Record<string, string>;
}

export interface GcsFileLike {
	save: (
		data_object: Buffer,
		options: {
			resumable: boolean;
			metadata: { metadata: Record<string, string> };
			preconditionOpts?: { ifGenerationMatch: number };
		},
	) => Promise<unknown>;
	download: () => Promise<[Buffer]>;
	getMetadata: () => Promise<[GcsMetadata]>;
	delete: (options?: {
		preconditionOpts?: { ifGenerationMatch: number };
	}) => Promise<unknown>;
}

export interface GcsBucketLike {
	file: (path_object: string) => GcsFileLike;
	getFiles: (options: { prefix?: string }) => Promise<[GcsFileLike[]]>;
}

function getSha256(data_object: Buffer): string {
	return createHash("sha256").update(data_object).digest("hex");
}

function normalizeMetadata(metadata_gcs: GcsMetadata): DestinationObject {
	const sha256 = metadata_gcs.metadata?.sha256;
	if (metadata_gcs.name === undefined || metadata_gcs.generation === undefined
		|| metadata_gcs.size === undefined || metadata_gcs.updated === undefined
		|| sha256 === undefined) {
		throw new Error("GCS object metadata is incomplete");
	}

	return {
		path: metadata_gcs.name,
		generation: Number(metadata_gcs.generation),
		size_bytes: Number(metadata_gcs.size),
		sha256,
		updated_at: metadata_gcs.updated,
		metadata: metadata_gcs.metadata ?? {},
	};
}

export class GcsDestination implements BackupDestination {
	public constructor(private readonly bucket: GcsBucketLike) {}

	public async putObject(
		path_object: string,
		data_object: Buffer,
		options: PutObjectOptions = {},
	): Promise<DestinationObject> {
		const sha256 = getSha256(data_object);
		const file_object = this.bucket.file(path_object);
		const precondition_options = options.if_generation_match === undefined
			? {}
			: { preconditionOpts: { ifGenerationMatch: options.if_generation_match } };

		await file_object.save(data_object, {
			resumable: data_object.length > 5 * 1024 * 1024,
			metadata: {
				metadata: {
					...options.metadata,
					sha256,
				},
			},
			...precondition_options,
		});

		const metadata_object = await this.getFileMetadata(file_object);
		if (metadata_object.size_bytes !== data_object.length || metadata_object.sha256 !== sha256) {
			throw new Error(`GCS verification failed for ${path_object}`);
		}
		return metadata_object;
	}

	public async getObject(path_object: string): Promise<Buffer> {
		const [data_object] = await this.bucket.file(path_object).download();
		return data_object;
	}

	public async statObject(path_object: string): Promise<DestinationObject | null> {
		try {
			return await this.getFileMetadata(this.bucket.file(path_object));
		} catch (error) {
			if (getErrorCode(error) === 404) {
				return null;
			}
			throw error;
		}
	}

	public async deleteObject(path_object: string, generation: number): Promise<void> {
		await this.bucket.file(path_object).delete({
			preconditionOpts: { ifGenerationMatch: generation },
		});
	}

	public async listObjects(prefix_object: string): Promise<DestinationObject[]> {
		const [files_object] = await this.bucket.getFiles({ prefix: prefix_object });
		return Promise.all(files_object.map((file_object) => this.getFileMetadata(file_object)));
	}

	public async listCommittedManifests(prefix_object: string): Promise<string[]> {
		const objects_found = await this.listObjects(prefix_object);
		return objects_found
			.map((item_object) => item_object.path)
			.filter((path_object) => path_object.endsWith("/manifest.json"))
			.sort();
	}

	private async getFileMetadata(file_object: GcsFileLike): Promise<DestinationObject> {
		const [metadata_gcs] = await file_object.getMetadata();
		return normalizeMetadata(metadata_gcs);
	}
}

export function createGcsDestination(
	name_bucket: string,
	options_storage: StorageOptions = {},
): GcsDestination {
	const storage = new Storage(options_storage);
	return new GcsDestination(storage.bucket(name_bucket) as unknown as GcsBucketLike);
}

function getErrorCode(error: unknown): number | undefined {
	if (error !== null && typeof error === "object" && "code" in error) {
		const code_error = Reflect.get(error, "code");
		return typeof code_error === "number" ? code_error : undefined;
	}
	return undefined;
}
