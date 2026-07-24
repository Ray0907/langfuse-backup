import type { ProcessRunner } from "../../process/runProcess.js";
import { runProcess } from "../../process/runProcess.js";

export interface PostgresVersions {
	client_version: string;
	server_version: string;
}

function parseVersion(output_version: string, label_version: string): string {
	const match_version = output_version.match(/\b(\d+(?:\.\d+)+)\b/);
	if (match_version?.[1] === undefined) {
		throw new Error(`Unable to parse ${label_version} version`);
	}
	return match_version[1];
}

export async function getPostgresVersions(options: {
	database_url: string;
	pg_dump_path?: string;
	psql_path?: string;
	run_process?: ProcessRunner;
}): Promise<PostgresVersions> {
	const run_process = options.run_process ?? runProcess;
	const result_client = await run_process(options.pg_dump_path ?? "pg_dump", ["--version"]);
	const result_server = await run_process(options.psql_path ?? "psql", [
		"--dbname",
		options.database_url,
		"--tuples-only",
		"--no-align",
		"--command",
		"SHOW server_version",
	]);

	return {
		client_version: parseVersion(result_client.stdout, "pg_dump"),
		server_version: parseVersion(result_server.stdout, "PostgreSQL server"),
	};
}
