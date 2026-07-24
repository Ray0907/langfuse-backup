import type { DestinationObject } from "../destination/types.js";
import type { BlobReceipt } from "../manifest/schema.js";
import type {
	BlobInventoryEntry,
	BlobInventoryPage,
} from "./types.js";
import { withCompressedInventory } from "./writeInventory.js";

export interface GcsInventorySource {
	isVersioningEnabled: () => Promise<boolean>;
	listObjectVersions?: (
		prefix_object: string,
		page_token?: string,
	) => Promise<BlobInventoryPage>;
	getPage?: (
		request_page: GcsInventoryPageRequest,
	) => Promise<GcsInventoryPage>;
}

export interface GcsInventoryPageRequest {
	prefix: string;
	page_token?: string;
	page_size: number;
}

export interface GcsInventoryPage {
	entries: BlobInventoryEntry[];
	next_page_token?: string;
}

export interface WriteGcsInventoryOptions {
	source: GcsInventorySource;
	prefixes: string[];
	immutable_bucket: boolean;
	inventory_path: string;
	upload_file: (
		path_object: string,
		path_file: string,
		metadata: Record<string, string>,
	) => Promise<DestinationObject>;
	page_size?: number;
	now?: () => Date;
}

export interface CreateGcsInventoryOptions {
	source: GcsInventorySource;
	prefixes: string[];
	inventory_path: string;
	immutable_bucket?: boolean;
	page_size?: number;
	upload_file: (upload: {
		path_object: string;
		path_file: string;
		metadata: Record<string, string>;
	}) => Promise<DestinationObject>;
	now?: () => Date;
}

function getRequiredString(
	value_object: Record<string, unknown>,
	name_field: string,
): string {
	const value_field = value_object[name_field];
	if (typeof value_field !== "string" || value_field.length === 0) {
		throw new Error(`GCS object version is missing ${name_field}`);
	}
	return value_field;
}

function getOptionalString(
	value_object: Record<string, unknown>,
	name_field: string,
): string | undefined {
	const value_field = value_object[name_field];
	if (value_field === undefined || value_field === null || value_field === "") {
		return undefined;
	}
	if (typeof value_field !== "string") {
		throw new Error(`GCS object version has invalid ${name_field}`);
	}
	return value_field;
}

function parseInventoryEntry(
	value_object: Record<string, unknown>,
): BlobInventoryEntry {
	const size_bytes = Number(value_object.size);
	if (!Number.isSafeInteger(size_bytes) || size_bytes < 0) {
		throw new Error("GCS object version has invalid size");
	}
	const md5_hash = getOptionalString(value_object, "md5_hash");
	const crc32c = getOptionalString(value_object, "crc32c");
	const etag = getOptionalString(value_object, "etag");
	const time_deleted = getOptionalString(value_object, "time_deleted");

	return {
		name: getRequiredString(value_object, "name"),
		generation: getRequiredString(value_object, "generation"),
		size_bytes,
		updated_at: getRequiredString(value_object, "updated_at"),
		...(md5_hash === undefined ? {} : { md5_hash }),
		...(crc32c === undefined ? {} : { crc32c }),
		...(etag === undefined ? {} : { etag }),
		...(time_deleted === undefined ? {} : { time_deleted }),
	};
}

async function* getInventoryEntries(
	source: GcsInventorySource,
	prefixes: string[],
	page_size: number,
): AsyncGenerator<BlobInventoryEntry> {
	let key_previous: string | undefined;

	for (const prefix_object of prefixes) {
		let page_token: string | undefined;
		do {
			let entries_page: BlobInventoryEntry[];
			let next_page_token: string | undefined;
			if (source.getPage !== undefined) {
				const page_inventory = await source.getPage({
					prefix: prefix_object,
					page_size,
					...(page_token === undefined ? {} : { page_token }),
				});
				entries_page = page_inventory.entries;
				next_page_token = page_inventory.next_page_token;
			} else if (source.listObjectVersions !== undefined) {
				const page_inventory = await source.listObjectVersions(
					prefix_object,
					page_token,
				);
				entries_page = page_inventory.objects.map(parseInventoryEntry);
				next_page_token = page_inventory.next_page_token;
			} else {
				throw new Error("GCS inventory source does not provide a paging method");
			}
			for (const entry_inventory of entries_page) {
				const key_entry = `${entry_inventory.name}\0${entry_inventory.generation}`;
				if (key_entry === key_previous) {
					throw new Error(`Duplicate GCS object generation: ${key_entry}`);
				}
				key_previous = key_entry;
				yield entry_inventory;
			}
			page_token = next_page_token;
		} while (page_token !== undefined);
	}
}

export async function writeGcsInventory(
	options: WriteGcsInventoryOptions,
): Promise<BlobReceipt> {
	const versioning_enabled = await options.source.isVersioningEnabled();
	if (!versioning_enabled && !options.immutable_bucket) {
		throw new Error(
			"GCS object versioning is required without an immutable-bucket guarantee",
		);
	}
	const get_now = options.now ?? (() => new Date());
	const started_at = get_now().toISOString();
	const result_inventory = await withCompressedInventory(
		getInventoryEntries(
			options.source,
			options.prefixes,
			options.page_size ?? 1_000,
		),
		async (path_file, metadata_inventory) => options.upload_file(
			options.inventory_path,
			path_file,
			{
				sha256: metadata_inventory.sha256,
				format: "ndjson+gzip",
			},
		),
	);
	const metadata_remote = result_inventory.result_upload;
	if (
		metadata_remote.size_bytes !== result_inventory.metadata.size_bytes
		|| metadata_remote.sha256 !== result_inventory.metadata.sha256
	) {
		throw new Error("GCS inventory upload verification failed");
	}
	const completed_at = get_now().toISOString();

	return {
		provider: "gcs_inventory",
		inventory_path: options.inventory_path,
		object_count: result_inventory.metadata.object_count,
		size_bytes: result_inventory.metadata.size_bytes,
		sha256: result_inventory.metadata.sha256,
		started_at,
		completed_at,
		verified_at: get_now().toISOString(),
	};
}

export async function createGcsInventory(
	options: CreateGcsInventoryOptions,
): Promise<BlobReceipt> {
	return writeGcsInventory({
		source: options.source,
		prefixes: options.prefixes,
		immutable_bucket: options.immutable_bucket ?? false,
		inventory_path: options.inventory_path,
		upload_file: async (path_object, path_file, metadata) =>
			options.upload_file({ path_object, path_file, metadata }),
		...(options.page_size === undefined ? {} : { page_size: options.page_size }),
		...(options.now === undefined ? {} : { now: options.now }),
	});
}
