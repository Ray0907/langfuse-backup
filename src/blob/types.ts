export interface BlobInventoryEntry {
	name: string;
	generation: string;
	size_bytes: number;
	updated_at: string;
	md5_hash?: string;
	crc32c?: string;
	etag?: string;
	time_deleted?: string;
}

export interface BlobInventoryPage {
	objects: Array<Record<string, unknown>>;
	next_page_token?: string;
}
