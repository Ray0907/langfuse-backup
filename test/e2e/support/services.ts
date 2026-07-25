import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
	CreateBucketCommand,
	GetObjectCommand,
	HeadBucketCommand,
	HeadObjectCommand,
	ListObjectsV2Command,
	PutObjectCommand,
	S3Client,
} from "@aws-sdk/client-s3";

import type { BlobReceipt } from "../../../src/manifest/schema.js";
import { restoreBlobStorage } from "../../../src/restore/restoreBlobStorage.js";
import { withCompressedInventory } from "../../../src/blob/writeInventory.js";
import type {
	BackupDestination,
	DestinationObject,
} from "../../../src/destination/types.js";
import type { ClickhouseQuery } from "../../../src/adapters/clickhouse/queryBackupStatus.js";
import { createComposeArgs, runText } from "./process.js";

export interface S3Fixture {
	client: S3Client;
	bucket: string;
}

export function createS3Fixture(options: {
	endpoint: string;
	access_key: string;
	secret_key: string;
	bucket: string;
}): S3Fixture {
	return {
		client: new S3Client({
			endpoint: options.endpoint,
			region: "us-east-1",
			forcePathStyle: true,
			credentials: {
				accessKeyId: options.access_key,
				secretAccessKey: options.secret_key,
			},
		}),
		bucket: options.bucket,
	};
}

export async function ensureBucket(fixture_s3: S3Fixture): Promise<void> {
	try {
		await fixture_s3.client.send(new HeadBucketCommand({
			Bucket: fixture_s3.bucket,
		}));
	} catch {
		await fixture_s3.client.send(new CreateBucketCommand({
			Bucket: fixture_s3.bucket,
		}));
	}
}

export async function putS3Object(
	fixture_s3: S3Fixture,
	path_object: string,
	data_object: Buffer,
): Promise<DestinationObject> {
	const sha256 = createHash("sha256").update(data_object).digest("hex");
	await fixture_s3.client.send(new PutObjectCommand({
		Bucket: fixture_s3.bucket,
		Key: path_object,
		Body: data_object,
		Metadata: { sha256 },
	}));
	return {
		path: path_object,
		generation: 1,
		size_bytes: data_object.byteLength,
		sha256,
		updated_at: new Date().toISOString(),
		metadata: { sha256 },
	};
}

export async function getS3Object(
	fixture_s3: S3Fixture,
	path_object: string,
): Promise<Buffer> {
	const result_object = await fixture_s3.client.send(new GetObjectCommand({
		Bucket: fixture_s3.bucket,
		Key: path_object,
	}));
	if (result_object.Body === undefined) {
		throw new Error(`S3 object body is missing: ${path_object}`);
	}
	return Buffer.from(await result_object.Body.transformToByteArray());
}

export async function statS3Object(
	fixture_s3: S3Fixture,
	path_object: string,
): Promise<DestinationObject | null> {
	try {
		const result_object = await fixture_s3.client.send(new HeadObjectCommand({
			Bucket: fixture_s3.bucket,
			Key: path_object,
		}));
		const sha256 = result_object.Metadata?.sha256;
		if (result_object.ContentLength === undefined || sha256 === undefined) {
			throw new Error(`S3 object metadata is incomplete: ${path_object}`);
		}
		return {
			path: path_object,
			generation: 1,
			size_bytes: result_object.ContentLength,
			sha256,
			updated_at: result_object.LastModified?.toISOString()
				?? new Date(0).toISOString(),
			metadata: { sha256 },
		};
	} catch (error) {
		if (isS3NotFound(error)) {
			return null;
		}
		throw error;
	}
}

export async function countS3Objects(
	fixture_s3: S3Fixture,
	prefix_object = "",
): Promise<number> {
	const result_list = await fixture_s3.client.send(new ListObjectsV2Command({
		Bucket: fixture_s3.bucket,
		Prefix: prefix_object,
	}));
	return result_list.KeyCount ?? 0;
}

function isS3NotFound(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}
	return ["NotFound", "NoSuchKey"].includes(error.name)
		|| error.message.includes("Status Code: 404");
}

export function createClickhouseQuery(options: {
	endpoint: string;
	password: string;
}): ClickhouseQuery {
	return async (text_query) => {
		const response_query = await fetch(options.endpoint, {
			method: "POST",
			headers: {
				"X-ClickHouse-User": "default",
				"X-ClickHouse-Key": options.password,
			},
			body: text_query,
		});
		const text_response = await response_query.text();
		if (!response_query.ok) {
			throw new Error(`ClickHouse query failed: ${text_response}`);
		}
		if (text_response.trim() === "") {
			return { data: [] };
		}
		const value_response: unknown = JSON.parse(text_response);
		if (value_response === null || typeof value_response !== "object"
			|| !("data" in value_response) || !Array.isArray(value_response.data)) {
			throw new Error("ClickHouse response did not include JSON data");
		}
		return { data: value_response.data as Array<Record<string, unknown>> };
	};
}

export async function getComposePort(options: {
	path_compose: string;
	name_project: string;
	name_service: string;
	port_container: number;
	env: NodeJS.ProcessEnv;
}): Promise<number> {
	const text_port = await runText("docker", createComposeArgs(
		options.path_compose,
		options.name_project,
		["port", options.name_service, String(options.port_container)],
	), { env: options.env });
	const match_port = /:(\d+)$/.exec(text_port);
	if (match_port?.[1] === undefined) {
		throw new Error(`Unable to parse published port: ${text_port}`);
	}
	return Number(match_port[1]);
}

export async function waitForHttp(url_service: string): Promise<void> {
	let error_last: unknown;
	for (let attempt_wait = 0; attempt_wait < 60; attempt_wait += 1) {
		try {
			const response_health = await fetch(url_service);
			if (response_health.ok) {
				return;
			}
			error_last = new Error(`HTTP ${response_health.status}`);
		} catch (error) {
			error_last = error;
		}
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	throw new Error(`Service did not become ready: ${String(error_last)}`);
}

export async function backupBlobs(options: {
	source: S3Fixture;
	destination: BackupDestination;
	deployment_id: string;
	backup_id: string;
	keys: string[];
}): Promise<BlobReceipt> {
	const time_started = new Date().toISOString();
	const entries_inventory: object[] = [];
	for (const path_source of options.keys) {
		const data_object = await getS3Object(options.source, path_source);
		const path_destination = `deployments/${options.deployment_id}/backups/`
			+ `${options.backup_id}/staging/blob/${path_source}`;
		const metadata_destination = await options.destination.putObject(
			path_destination,
			data_object,
			{ if_generation_match: 0 },
		);
		entries_inventory.push({
			source_key: path_source,
			size_bytes: data_object.byteLength,
			destination_path: path_destination,
			destination_generation: metadata_destination.generation,
			destination_sha256: metadata_destination.sha256,
		});
	}
	const path_inventory = `deployments/${options.deployment_id}/backups/`
		+ `${options.backup_id}/staging/blob-inventory.ndjson.gz`;
	const result_inventory = await withCompressedInventory(
		toAsyncEntries(entries_inventory),
		async (path_file, metadata_inventory) => {
			await options.destination.putObject(
				path_inventory,
				await readFile(path_file),
				{
					if_generation_match: 0,
					metadata: { sha256: metadata_inventory.sha256 },
				},
			);
		},
	);
	const time_completed = new Date().toISOString();
	return {
		provider: "s3_copy",
		inventory_path: path_inventory,
		object_count: entries_inventory.length,
		size_bytes: result_inventory.metadata.size_bytes,
		sha256: result_inventory.metadata.sha256,
		started_at: time_started,
		completed_at: time_completed,
		verified_at: time_completed,
	};
}

async function* toAsyncEntries(entries_inventory: object[]): AsyncGenerator<object> {
	for (const entry_inventory of entries_inventory) {
		yield entry_inventory;
	}
}

export async function restoreBlobs(options: {
	receipt: BlobReceipt;
	destination: BackupDestination;
	target: S3Fixture;
}): Promise<void> {
	const entries_journal: Array<{
		path: string;
		size_bytes: number;
		sha256: string;
		target_generation: number;
		source_path: string;
		source_generation?: string;
	}> = [];
	await restoreBlobStorage({
		receipt: options.receipt,
		inventory_data: await options.destination.getObject(
			options.receipt.inventory_path,
		),
		read_backup_object: async (reference_object) => ({
			data: await options.destination.getObject(reference_object.path),
		}),
		stat_target_object: async (path_object) =>
			statS3Object(options.target, path_object),
		write_target_object: async (path_object, data_object) =>
			putS3Object(options.target, path_object, data_object),
		read_journal: async () => entries_journal,
		append_journal: async (entry_journal) => {
			entries_journal.push(entry_journal);
		},
	});
}
