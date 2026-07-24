import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Logger } from "../logging/logger.js";
import type { PostgresReceipt } from "../manifest/schema.js";
import type { ProcessRunner } from "../process/runProcess.js";
import { runProcess } from "../process/runProcess.js";

export interface RestorePostgresOptions {
	receipt: PostgresReceipt;
	target_database_url: string;
	check_target_empty: () => Promise<boolean>;
	download_dump: (path_object: string) => Promise<Buffer>;
	pg_restore_path?: string;
	run_process?: ProcessRunner;
	logger?: Logger;
}

export interface RestorePostgresResult {
	restored: true;
	client_version: string;
	size_bytes: number;
	sha256: string;
	exit_code: 0;
	stderr: string;
}

function parseVersion(output_version: string): string {
	const match_version = output_version.match(/\b(\d+(?:\.\d+)+)\b/);
	if (match_version?.[1] === undefined) {
		throw new Error("Unable to parse pg_restore version");
	}
	return match_version[1];
}

function getMajor(value_version: string): string {
	return value_version.split(".")[0] ?? "";
}

export async function restorePostgres(
	options: RestorePostgresOptions,
): Promise<RestorePostgresResult> {
	if (!await options.check_target_empty()) {
		throw new Error("PostgreSQL restore target is not empty");
	}
	const run_process = options.run_process ?? runProcess;
	const path_pg_restore = options.pg_restore_path ?? "pg_restore";
	const result_version = await run_process(path_pg_restore, ["--version"]);
	const client_version = parseVersion(result_version.stdout);
	if (getMajor(client_version) !== getMajor(options.receipt.client_version)) {
		throw new Error(
			`pg_restore version is incompatible: ${client_version} `
			+ `for dump client ${options.receipt.client_version}`,
		);
	}

	const data_dump = await options.download_dump(options.receipt.object_path);
	const sha256 = createHash("sha256").update(data_dump).digest("hex");
	if (data_dump.byteLength !== options.receipt.size_bytes
		|| sha256 !== options.receipt.sha256) {
		throw new Error("PostgreSQL dump size or checksum mismatch");
	}

	const path_temporary = await mkdtemp(join(tmpdir(), "langfuse-postgres-restore-"));
	const path_dump = join(path_temporary, "postgres.dump");
	try {
		await writeFile(path_dump, data_dump, { mode: 0o600 });
		const result_restore = await run_process(path_pg_restore, [
			"--dbname",
			options.target_database_url,
			"--no-owner",
			"--no-acl",
			"--exit-on-error",
			path_dump,
		], options.logger === undefined ? {} : { logger: options.logger });
		return {
			restored: true,
			client_version,
			size_bytes: data_dump.byteLength,
			sha256,
			exit_code: 0,
			stderr: result_restore.stderr,
		};
	} finally {
		await rm(path_temporary, { recursive: true, force: true });
	}
}
