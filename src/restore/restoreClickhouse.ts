import { randomUUID } from "node:crypto";

import { getClickhouseVersion } from "../adapters/clickhouse/clickhouseDoctor.js";
import {
	queryBackupStatus,
	type ClickhouseQuery,
} from "../adapters/clickhouse/queryBackupStatus.js";
import type { ClickhouseReceipt } from "../manifest/schema.js";

export interface ClickhouseRestoreEvidence {
	operation_id: string;
	status: "RESTORED";
	database: string;
	object_prefix: string;
	server_version: string;
	completed_at: string;
}

export interface RestoreClickhouseOptions {
	query: ClickhouseQuery;
	receipt: ClickhouseReceipt;
	named_collection: string;
	check_target_empty: () => Promise<boolean>;
	create_operation_id?: () => string;
	max_poll_attempts?: number;
	sleep?: (duration_ms: number) => Promise<void>;
	now?: () => Date;
	write_journal?: (evidence_restore: ClickhouseRestoreEvidence) => Promise<void>;
}

function quoteIdentifier(value_identifier: string): string {
	return `\`${value_identifier.replaceAll("`", "``")}\``;
}

function quoteString(value_string: string): string {
	return `'${value_string.replaceAll("\\", "\\\\").replaceAll("'", "''")}'`;
}

function assertNamedCollection(name_collection: string): void {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name_collection)) {
		throw new Error("Invalid ClickHouse named collection");
	}
}

function assertCompatibleVersion(source_version: string, target_version: string): void {
	const source_parts = source_version.split(".").slice(0, 2).join(".");
	const target_parts = target_version.split(".").slice(0, 2).join(".");
	if (source_parts !== target_parts) {
		throw new Error(
			`ClickHouse versions are incompatible: ${source_version} -> ${target_version}`,
		);
	}
}

function sleepDefault(duration_ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, duration_ms));
}

export async function restoreClickhouse(
	options: RestoreClickhouseOptions,
): Promise<ClickhouseRestoreEvidence> {
	if (!await options.check_target_empty()) {
		throw new Error("ClickHouse restore target is not empty");
	}
	assertNamedCollection(options.named_collection);
	const max_poll_attempts = options.max_poll_attempts ?? 20;
	if (!Number.isSafeInteger(max_poll_attempts) || max_poll_attempts < 1) {
		throw new Error("ClickHouse max poll attempts must be a positive integer");
	}
	const get_now = options.now ?? (() => new Date());
	const sleep = options.sleep ?? sleepDefault;
	const server_version = await getClickhouseVersion(options.query);
	assertCompatibleVersion(options.receipt.server_version, server_version);
	const id_fallback = options.create_operation_id?.() ?? randomUUID();
	const target_backup = `S3(${options.named_collection}, `
		+ `${quoteString(options.receipt.object_prefix)})`;

	const result_start = await options.query(
		`RESTORE DATABASE ${quoteIdentifier(options.receipt.database)} `
		+ `FROM ${target_backup} ASYNC FORMAT JSON`,
	);
	const id_server = result_start.data[0]?.id;
	const operation_id = typeof id_server === "string" && id_server !== ""
		? id_server
		: id_fallback;

	for (let attempt_poll = 0; attempt_poll < max_poll_attempts; attempt_poll += 1) {
		const status_restore = await queryBackupStatus(options.query, operation_id);
		if (status_restore.status === "RESTORED") {
			const evidence_restore: ClickhouseRestoreEvidence = {
				operation_id,
				status: "RESTORED",
				database: options.receipt.database,
				object_prefix: options.receipt.object_prefix,
				server_version,
				completed_at: get_now().toISOString(),
			};
			await options.write_journal?.(evidence_restore);
			return evidence_restore;
		}
		if (!["PENDING", "RESTORING"].includes(status_restore.status)) {
			throw new Error(
				`ClickHouse restore ${operation_id} ended with `
				+ `${status_restore.status}: ${status_restore.error}`,
			);
		}
		if (attempt_poll + 1 < max_poll_attempts) {
			await sleep(Math.min(250 * (2 ** attempt_poll), 5_000));
		}
	}

	throw new Error(`ClickHouse restore ${operation_id} timed out`);
}
