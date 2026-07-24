export interface PutObjectOptions {
	if_generation_match?: number;
	metadata?: Record<string, string>;
}

export interface DestinationObject {
	path: string;
	generation: number;
	size_bytes: number;
	sha256: string;
	updated_at: string;
	metadata: Record<string, string>;
}

export interface BackupDestination {
	putObject: (
		path_object: string,
		data_object: Buffer,
		options?: PutObjectOptions,
	) => Promise<DestinationObject>;
	getObject: (path_object: string) => Promise<Buffer>;
	statObject: (path_object: string) => Promise<DestinationObject | null>;
	deleteObject: (path_object: string, generation: number) => Promise<void>;
	listObjects: (prefix_object: string) => Promise<DestinationObject[]>;
}
