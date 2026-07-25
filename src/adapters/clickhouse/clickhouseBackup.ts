import { randomUUID } from "node:crypto";

import type { ClickhouseReceipt } from "../../manifest/schema.js";
import { getClickhouseVersion } from "./clickhouseDoctor.js";
import {
	queryBackupStatus,
	type ClickhouseQuery,
} from "./queryBackupStatus.js";

export type { ClickhouseQuery } from "./queryBackupStatus.js";

export interface CreateClickhouseBackupOptions {
	query: ClickhouseQuery;
	deployment_id: string;
	backup_id: string;
	database: string;
	named_collection?: string;
	s3_endpoint?: string;
	hmac_access_key?: string;
	hmac_secret_key?: string;
	allow_inline_hmac?: boolean;
	create_operation_id?: () => string;
	max_poll_attempts?: number;
	sleep?: (duration_ms: number) => Promise<void>;
	now?: () => Date;
}

function quoteIdentifier(value_identifier: string): string {
	return `\`${value_identifier.replaceAll("`", "``")}\``;
}

function quoteString(value_string: string): string {
	return `'${value_string.replaceAll("\\", "\\\\").replaceAll("'", "''")}'`;
}

function createBackupTarget(
	options: CreateClickhouseBackupOptions,
	path_remote: string,
): string {
	if (options.named_collection !== undefined) {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(options.named_collection)) {
			throw new Error("Invalid ClickHouse named collection");
		}
		return `S3(${options.named_collection}, ${quoteString(path_remote)})`;
	}
	if (options.allow_inline_hmac !== true || options.s3_endpoint === undefined
		|| options.hmac_access_key === undefined || options.hmac_secret_key === undefined) {
		throw new Error("ClickHouse backup requires a named collection");
	}
	const url_remote = `${options.s3_endpoint.replace(/\/$/, "")}/${path_remote}`;
	return `S3(${quoteString(url_remote)}, ${quoteString(options.hmac_access_key)}, `
		+ `${quoteString(options.hmac_secret_key)})`;
}

function sleepDefault(duration_ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, duration_ms));
}

export async function createClickhouseBackup(
	options: CreateClickhouseBackupOptions,
): Promise<ClickhouseReceipt> {
	const get_now = options.now ?? (() => new Date());
	const sleep = options.sleep ?? sleepDefault;
	const max_poll_attempts = options.max_poll_attempts ?? 20;
	const id_path = options.create_operation_id?.() ?? randomUUID();
	const path_remote = `${options.deployment_id}/backups/${options.backup_id}`
		+ `/clickhouse/${id_path}`;
	const started_at = get_now().toISOString();
	const server_version = await getClickhouseVersion(options.query);
	const target_backup = createBackupTarget(options, path_remote);

	const result_start = await options.query(
		`BACKUP DATABASE ${quoteIdentifier(options.database)} TO ${target_backup} `
		+ "ASYNC FORMAT JSON",
	);
	const id_server = result_start.data[0]?.id;
	const operation_id = typeof id_server === "string" && id_server !== ""
		? id_server
		: id_path;

	for (let attempt_poll = 0; attempt_poll < max_poll_attempts; attempt_poll += 1) {
		const status_backup = await queryBackupStatus(options.query, operation_id);
		if (status_backup.status === "BACKUP_CREATED") {
			const completed_at = get_now().toISOString();
			return {
				provider: "clickhouse",
				operation_id,
				database: options.database,
				object_prefix: path_remote,
				status: "BACKUP_CREATED",
				size_bytes: status_backup.total_size,
				started_at,
				completed_at,
				verified_at: get_now().toISOString(),
				server_version,
				num_files: status_backup.num_files,
			};
		}
		if (["BACKUP_FAILED", "BACKUP_CANCELLED", "UNKNOWN"].includes(status_backup.status)) {
			throw new Error(
				`ClickHouse backup ${operation_id} ended with ${status_backup.status}: `
				+ status_backup.error,
			);
		}
		if (attempt_poll + 1 < max_poll_attempts) {
			await sleep(Math.min(250 * (2 ** attempt_poll), 5_000));
		}
	}

	throw new Error(`ClickHouse backup ${operation_id} timed out`);
}
