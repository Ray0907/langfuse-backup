import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BackupDestination } from "../../destination/types.js";
import type { Logger } from "../../logging/logger.js";
import type { PostgresReceipt } from "../../manifest/schema.js";
import type { ProcessRunner } from "../../process/runProcess.js";
import { runProcess } from "../../process/runProcess.js";
import { getPostgresVersions } from "./postgresDoctor.js";

export interface CreatePostgresBackupOptions {
	destination: BackupDestination;
	deployment_id: string;
	backup_id: string;
	database_url: string;
	pg_dump_path?: string;
	psql_path?: string;
	run_process?: ProcessRunner;
	logger?: Logger;
	now?: () => Date;
}

export async function createPostgresBackup(
	options: CreatePostgresBackupOptions,
): Promise<PostgresReceipt> {
	const run_process = options.run_process ?? runProcess;
	const get_now = options.now ?? (() => new Date());
	const started_at = get_now().toISOString();
	const path_temporary = await mkdtemp(join(tmpdir(), "langfuse-backup-postgres-"));
	const path_dump = join(path_temporary, "postgres.dump");
	const path_object = `deployments/${options.deployment_id}/backups/`
		+ `${options.backup_id}/staging/postgres.dump`;

	try {
		const versions_postgres = await getPostgresVersions({
			database_url: options.database_url,
			run_process,
			...(options.pg_dump_path === undefined
				? {}
				: { pg_dump_path: options.pg_dump_path }),
			...(options.psql_path === undefined ? {} : { psql_path: options.psql_path }),
		});
		await run_process(options.pg_dump_path ?? "pg_dump", [
			"--format=custom",
			`--file=${path_dump}`,
			"--no-owner",
			"--no-acl",
			options.database_url,
		], options.logger === undefined ? {} : { logger: options.logger });

		const data_dump = await readFile(path_dump);
		const sha256 = createHash("sha256").update(data_dump).digest("hex");
		const metadata_remote = await options.destination.putObject(path_object, data_dump, {
			if_generation_match: 0,
			metadata: {
				component: "postgres",
				backup_id: options.backup_id,
			},
		});
		if (metadata_remote.size_bytes !== data_dump.length || metadata_remote.sha256 !== sha256) {
			throw new Error("PostgreSQL dump remote verification failed");
		}

		const completed_at = get_now().toISOString();
		return {
			provider: "postgres",
			object_path: path_object,
			size_bytes: data_dump.length,
			sha256,
			started_at,
			completed_at,
			verified_at: get_now().toISOString(),
			client_version: versions_postgres.client_version,
			server_version: versions_postgres.server_version,
		};
	} finally {
		await rm(path_temporary, { recursive: true, force: true });
	}
}
