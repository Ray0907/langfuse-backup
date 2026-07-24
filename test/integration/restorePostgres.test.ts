import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { PostgresReceipt } from "../../src/manifest/schema.js";
import { ProcessError, runProcess } from "../../src/process/runProcess.js";
import { restorePostgres } from "../../src/restore/restorePostgres.js";

const image_postgres = "postgres:17-bookworm";

async function waitForPostgres(name_container: string): Promise<void> {
	for (let attempt = 0; attempt < 40; attempt += 1) {
		try {
			await runProcess("docker", [
				"exec",
				name_container,
				"pg_isready",
				"--username",
				"postgres",
			]);
			return;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
	}
	throw new Error(`PostgreSQL container ${name_container} did not become ready`);
}

describe("PostgreSQL restore integration", () => {
	it("restores representative Langfuse relational records", async () => {
		const id_test = randomUUID();
		const name_network = `langfuse-restore-${id_test}`;
		const name_source = `langfuse-source-${id_test}`;
		const name_target = `langfuse-target-${id_test}`;
		const path_test = await mkdtemp(join(tmpdir(), "langfuse-postgres-restore-e2e-"));

		await runProcess("docker", ["network", "create", name_network]);
		try {
			for (const [name_container, password] of [
				[name_source, "source-pass"],
				[name_target, "target-pass"],
			] as const) {
				await runProcess("docker", [
					"run",
					"--detach",
					"--rm",
					"--network",
					name_network,
					"--name",
					name_container,
					"--env",
					`POSTGRES_PASSWORD=${password}`,
					image_postgres,
				], { timeout_ms: 90_000 });
			}
			await Promise.all([
				waitForPostgres(name_source),
				waitForPostgres(name_target),
			]);

			const sql_seed = [
				"CREATE TABLE users(id text primary key);",
				"CREATE TABLE projects(id text primary key);",
				"CREATE TABLE prompts(id text primary key);",
				"CREATE TABLE datasets(id text primary key);",
				"CREATE TABLE api_keys(id text primary key);",
				"INSERT INTO users VALUES ('user-1');",
				"INSERT INTO projects VALUES ('project-1');",
				"INSERT INTO prompts VALUES ('prompt-1');",
				"INSERT INTO datasets VALUES ('dataset-1');",
				"INSERT INTO api_keys VALUES ('key-1');",
			].join(" ");
			await runProcess("docker", [
				"exec",
				name_source,
				"psql",
				"--username",
				"postgres",
				"--command",
				sql_seed,
			]);
			await runProcess("docker", [
				"exec",
				name_source,
				"pg_dump",
				"--username",
				"postgres",
				"--format=custom",
				"--file=/tmp/source.dump",
				"postgres",
			]);
			const path_dump = join(path_test, "source.dump");
			await runProcess("docker", [
				"cp",
				`${name_source}:/tmp/source.dump`,
				path_dump,
			]);
			const data_dump = await readFile(path_dump);
			const receipt: PostgresReceipt = {
				provider: "postgres",
				object_path: "backup/postgres.dump",
				size_bytes: data_dump.byteLength,
				sha256: createHash("sha256").update(data_dump).digest("hex"),
				started_at: "2026-07-24T12:00:00.000Z",
				completed_at: "2026-07-24T12:01:00.000Z",
				verified_at: "2026-07-24T12:01:01.000Z",
				client_version: "17.6",
				server_version: "17.6",
			};

			const path_wrapper = join(path_test, "pg-restore-wrapper.mjs");
			await writeFile(path_wrapper, `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { basename, dirname } from "node:path";
const args = process.argv.slice(2);
let dockerArgs;
if (args[0] === "--version") {
	dockerArgs = ["run", "--rm", "--entrypoint", "pg_restore", "${image_postgres}", "--version"];
} else {
	const dumpPath = args.pop();
	dockerArgs = [
		"run", "--rm", "--network", "${name_network}",
		"--volume", dirname(dumpPath) + ":/restore:ro",
		"--entrypoint", "pg_restore", "${image_postgres}",
		...args, "/restore/" + basename(dumpPath),
	];
}
const result = spawnSync("docker", dockerArgs, { stdio: "inherit" });
process.exit(result.status ?? 1);
`, { mode: 0o700 });
			await chmod(path_wrapper, 0o700);

			await restorePostgres({
				receipt,
				target_database_url:
					`postgres://postgres:target-pass@${name_target}:5432/postgres`,
				check_target_empty: async () => {
					const result_tables = await runProcess("docker", [
						"exec",
						name_target,
						"psql",
						"--username",
						"postgres",
						"--tuples-only",
						"--no-align",
						"--command",
						"SELECT count(*) FROM pg_tables WHERE schemaname = 'public'",
					]);
					return result_tables.stdout.trim() === "0";
				},
				download_dump: async () => data_dump,
				pg_restore_path: path_wrapper,
			});

			for (const name_table of [
				"users",
				"projects",
				"prompts",
				"datasets",
				"api_keys",
			]) {
				const result_count = await runProcess("docker", [
					"exec",
					name_target,
					"psql",
					"--username",
					"postgres",
					"--tuples-only",
					"--no-align",
					"--command",
					`SELECT count(*) FROM ${name_table}`,
				]);
				expect(result_count.stdout.trim()).toBe("1");
			}
		} catch (error) {
			if (error instanceof ProcessError) {
				throw new Error(`${error.message}: ${error.stderr}`, { cause: error });
			}
			throw error;
		} finally {
			await Promise.all([name_source, name_target].map(async (name_container) =>
				runProcess("docker", ["rm", "--force", name_container])
					.catch(() => undefined)));
			await runProcess("docker", ["network", "rm", name_network])
				.catch(() => undefined);
			await rm(path_test, { recursive: true, force: true });
		}
	}, 120_000);
});
