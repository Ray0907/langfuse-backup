import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import type { PostgresReceipt } from "../../src/manifest/schema.js";
import {
	ProcessError,
	type ProcessRunner,
} from "../../src/process/runProcess.js";
import { restorePostgres } from "../../src/restore/restorePostgres.js";

const data_dump = Buffer.from("custom-format-dump");
const receipt_postgres: PostgresReceipt = {
	provider: "postgres",
	object_path: "backup/postgres.dump",
	size_bytes: data_dump.byteLength,
	sha256: createHash("sha256").update(data_dump).digest("hex"),
	started_at: "2026-07-24T12:00:00.000Z",
	completed_at: "2026-07-24T12:00:00.000Z",
	verified_at: "2026-07-24T12:00:00.000Z",
	client_version: "17.5",
	server_version: "17.5",
};

describe("restorePostgres", () => {
	it("verifies the dump and restores an empty database without --clean", async () => {
		const calls_process: Array<{ command: string; arguments_process: string[] }> = [];
		const run_process: ProcessRunner = async (command, arguments_process) => {
			calls_process.push({ command, arguments_process });
			if (arguments_process.includes("--version")) {
				return {
					command,
					exit_code: 0,
					stdout: "pg_restore (PostgreSQL) 17.6",
					stderr: "",
					duration_ms: 1,
				};
			}
			const path_dump = arguments_process.at(-1);
			expect(path_dump === undefined ? undefined : await readFile(path_dump))
				.toEqual(data_dump);
			return {
				command,
				exit_code: 0,
				stdout: "",
				stderr: "restored with notices",
				duration_ms: 2,
			};
		};

		const evidence = await restorePostgres({
			receipt: receipt_postgres,
			target_database_url: "postgres://user:secret@target/langfuse",
			download_dump: async () => data_dump,
			check_target_empty: async () => true,
			pg_restore_path: "pg_restore",
			run_process,
		});

		const arguments_restore = calls_process[1]?.arguments_process ?? [];
		expect(arguments_restore).toContain("--exit-on-error");
		expect(arguments_restore).not.toContain("--clean");
		expect(evidence).toMatchObject({
			client_version: "17.6",
			exit_code: 0,
			stderr: "restored with notices",
		});
	});

	it("rejects a non-empty target or incompatible pg_restore before restoring", async () => {
		const run_process = vi.fn<ProcessRunner>();

		await expect(restorePostgres({
			receipt: receipt_postgres,
			target_database_url: "postgres://target/langfuse",
			download_dump: async () => data_dump,
			check_target_empty: async () => false,
			run_process,
		})).rejects.toThrow(/target.*not empty/i);
		expect(run_process).not.toHaveBeenCalled();

		run_process.mockResolvedValue({
			command: "pg_restore",
			exit_code: 0,
			stdout: "pg_restore (PostgreSQL) 16.9",
			stderr: "",
			duration_ms: 1,
		});
		await expect(restorePostgres({
			receipt: receipt_postgres,
			target_database_url: "postgres://target/langfuse",
			download_dump: async () => data_dump,
			check_target_empty: async () => true,
			run_process,
		})).rejects.toThrow(/pg_restore.*incompatible/i);
		expect(run_process).toHaveBeenCalledTimes(1);
	});

	it("rejects dump checksum mismatches before invoking restore", async () => {
		const run_process: ProcessRunner = async (command) => ({
			command,
			exit_code: 0,
			stdout: "pg_restore (PostgreSQL) 17.6",
			stderr: "",
			duration_ms: 1,
		});
		const spy_process = vi.fn(run_process);

		await expect(restorePostgres({
			receipt: receipt_postgres,
			target_database_url: "postgres://target/langfuse",
			download_dump: async () => Buffer.from("tampered"),
			check_target_empty: async () => true,
			run_process: spy_process,
		})).rejects.toThrow(/dump.*mismatch/i);
		expect(spy_process).toHaveBeenCalledTimes(1);
	});

	it("preserves redacted stderr and the pg_restore exit code", async () => {
		const error_process = new ProcessError(
			"pg_restore exited with code 7",
			{
				command: "pg_restore",
				exit_code: 7,
				stdout: "",
				stderr: "postgres://[REDACTED]@target/langfuse",
				duration_ms: 1,
			},
			{ timed_out: false, cancelled: false },
		);
		const run_process: ProcessRunner = async (command, arguments_process) => {
			if (arguments_process.includes("--version")) {
				return {
					command,
					exit_code: 0,
					stdout: "pg_restore (PostgreSQL) 17.6",
					stderr: "",
					duration_ms: 1,
				};
			}
			throw error_process;
		};

		await expect(restorePostgres({
			receipt: receipt_postgres,
			target_database_url: "postgres://user:secret@target/langfuse",
			download_dump: async () => data_dump,
			check_target_empty: async () => true,
			run_process,
		})).rejects.toBe(error_process);
		expect(error_process).toMatchObject({
			exit_code: 7,
			stderr: expect.not.stringContaining("secret") as string,
		});
	});
});
