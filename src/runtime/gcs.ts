import type { Bucket, File, StorageOptions } from "@google-cloud/storage";
import { Storage } from "@google-cloud/storage";

import type { BlobInventoryEntry } from "../blob/types.js";
import type { GcsInventorySource } from "../blob/gcsInventory.js";
import type { BackupConfig, SecretReference } from "../config/schema.js";
import {
	createGcsDestination,
	type GcsDestination,
} from "../destination/gcsDestination.js";
import type { DestinationObject } from "../destination/types.js";
import {
	createPrefixedDestination,
	getPrefixedPath,
} from "./prefixedDestination.js";
import { resolveSecret } from "./secret.js";

export interface RuntimeGcsDestination {
	base: GcsDestination;
	bucket: Bucket;
	destination: ReturnType<typeof createPrefixedDestination>;
	prefix: string;
	uploadFile: (
		path_object: string,
		path_file: string,
		metadata: Record<string, string>,
	) => Promise<DestinationObject>;
}

function getMetadataString(
	metadata_file: Record<string, unknown>,
	name_metadata: string,
): string | undefined {
	const value_metadata = metadata_file[name_metadata];
	return typeof value_metadata === "string" && value_metadata !== ""
		? value_metadata
		: undefined;
}

function createInventoryEntry(
	metadata_file: Record<string, unknown>,
): BlobInventoryEntry {
	const name_object = getMetadataString(metadata_file, "name");
	const generation_object = getMetadataString(metadata_file, "generation");
	const updated_at = getMetadataString(metadata_file, "updated");
	const size_bytes = Number(metadata_file.size);
	if (name_object === undefined || generation_object === undefined
		|| updated_at === undefined || !Number.isSafeInteger(size_bytes)
		|| size_bytes < 0) {
		throw new Error("GCS object version metadata is incomplete");
	}
	const md5_hash = getMetadataString(metadata_file, "md5Hash");
	const crc32c = getMetadataString(metadata_file, "crc32c");
	const etag = getMetadataString(metadata_file, "etag");
	const time_deleted = getMetadataString(metadata_file, "timeDeleted");
	return {
		name: name_object,
		generation: generation_object,
		size_bytes,
		updated_at,
		...(md5_hash === undefined ? {} : { md5_hash }),
		...(crc32c === undefined ? {} : { crc32c }),
		...(etag === undefined ? {} : { etag }),
		...(time_deleted === undefined ? {} : { time_deleted }),
	};
}

async function getStorageOptions(
	reference_credentials?: SecretReference,
): Promise<StorageOptions> {
	if (reference_credentials === undefined) {
		return {};
	}
	const text_credentials = await resolveSecret(reference_credentials);
	let value_credentials: unknown;
	try {
		value_credentials = JSON.parse(text_credentials);
	} catch {
		throw new Error("GCS credentials reference must contain a JSON service account");
	}
	if (value_credentials === null || typeof value_credentials !== "object") {
		throw new Error("GCS credentials reference must contain a JSON object");
	}
	return { credentials: value_credentials };
}

async function uploadFile(
	destination_runtime: Omit<RuntimeGcsDestination, "uploadFile">,
	path_object: string,
	path_file: string,
	metadata: Record<string, string>,
): Promise<DestinationObject> {
	const path_physical = getPrefixedPath(destination_runtime.prefix, path_object);
	await destination_runtime.bucket.upload(path_file, {
		destination: path_physical,
		resumable: true,
		metadata: {
			metadata,
		},
		preconditionOpts: {
			ifGenerationMatch: 0,
		},
	});
	const object_uploaded = await destination_runtime.destination.statObject(path_object);
	if (object_uploaded === null) {
		throw new Error(`GCS upload metadata is missing for ${path_object}`);
	}
	return object_uploaded;
}

export async function createRuntimeGcsDestination(
	config_destination: BackupConfig["destination"],
): Promise<RuntimeGcsDestination> {
	const options_storage = await getStorageOptions(config_destination.credentials);
	const storage = new Storage(options_storage);
	const bucket = storage.bucket(config_destination.bucket);
	const base = createGcsDestination(
		config_destination.bucket,
		options_storage,
	);
	const destination = createPrefixedDestination(base, config_destination.prefix);
	const destination_runtime = {
		base,
		bucket,
		destination,
		prefix: config_destination.prefix,
	};
	return {
		...destination_runtime,
		uploadFile: async (path_object, path_file, metadata) =>
			uploadFile(destination_runtime, path_object, path_file, metadata),
	};
}

export async function createRuntimeGcsBucket(
	name_bucket: string,
	reference_credentials?: SecretReference,
): Promise<Bucket> {
	const options_storage = await getStorageOptions(reference_credentials);
	return new Storage(options_storage).bucket(name_bucket);
}

async function getFileEntry(file_object: File): Promise<BlobInventoryEntry> {
	const [metadata_file] = await file_object.getMetadata();
	return createInventoryEntry(metadata_file as unknown as Record<string, unknown>);
}

export function createGcsInventorySource(bucket: Bucket): GcsInventorySource {
	return {
		async isVersioningEnabled() {
			const [metadata_bucket] = await bucket.getMetadata();
			return metadata_bucket.versioning?.enabled === true;
		},
		async getPage(request_page) {
			const [files_found, query_next] = await bucket.getFiles({
				prefix: request_page.prefix,
				versions: true,
				autoPaginate: false,
				maxResults: request_page.page_size,
				...(request_page.page_token === undefined
					? {}
					: { pageToken: request_page.page_token }),
			});
			const entries = await Promise.all(files_found.map(getFileEntry));
			const page_token = query_next?.pageToken;
			return {
				entries,
				...(page_token === undefined ? {} : { next_page_token: page_token }),
			};
		},
	};
}

export async function readGcsGeneration(
	bucket: Bucket,
	path_object: string,
	generation: string,
): Promise<Buffer> {
	const [data_object] = await bucket.file(path_object, { generation }).download();
	return data_object;
}

export async function hasGcsPrefix(bucket: Bucket, prefix_object: string): Promise<boolean> {
	const [files_found] = await bucket.getFiles({
		prefix: prefix_object,
		maxResults: 1,
		autoPaginate: false,
	});
	return files_found.length > 0;
}
