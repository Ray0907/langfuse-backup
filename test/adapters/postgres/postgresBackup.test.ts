import { writeFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import type {
	BackupDestination,
	DestinationObject,
} from "../../../src/destination/types.js";
import { createPostgresBackup } from "../../../src/adapters/postgres/postgresBackup.js";
import type { ProcessRunner } from "../../../src/process/runProcess.js";

interface MemoryDestination {
	destination: BackupDestination;
	objects: Map<string, Buffer>;
}

function createMemoryDestination(): MemoryDestination {
	const objects = new Map<string, Buffer>();
	return {
		objects,
		destination: {
			async putObject(path_object, data_object) {
				objects.set(path_object, Buffer.from(data_object));
				return {
					path: path_object,
					generation: 1,
					size_bytes: data_object.length,
					sha256: await getSha256(data_object),
					updated_at: "2026-07-24T12:00:00.000Z",
					metadata: {},
				};
			},
			async getObject(path_object) {
				return objects.get(path_object) ?? Buffer.alloc(0);
			},
			async statObject() {
				return null;
			},
			async deleteObject() {
				return undefined;
			},
			async listObjects() {
				return [] satisfies DestinationObject[];
			},
		},
	};
}

async function getSha256(data_value: Buffer): Promise<string> {
	const { createHash } = await import("node:crypto");
	return createHash("sha256").update(data_value).digest("hex");
}

describe("createPostgresBackup", () => {
	it("creates a custom dump, verifies upload metadata, and returns a receipt", async () => {
		const { destination, objects } = createMemoryDestination();
		const run_process: ProcessRunner = async (command, arguments_process) => {
			if (arguments_process[0] === "--version") {
				return {
					command,
					exit_code: 0,
					stdout: "pg_dump (PostgreSQL) 17.5",
					stderr: "",
					duration_ms: 1,
				};
			}
			if (command === "psql") {
				return {
					command,
					exit_code: 0,
					stdout: "17.5\n",
					stderr: "",
					duration_ms: 1,
				};
			}
			const argument_file = arguments_process.find(
				(argument) => argument.startsWith("--file="),
			);
			if (argument_file === undefined) {
				throw new Error("missing dump path");
			}
			await writeFile(argument_file.slice("--file=".length), "custom-format-dump");
			return { command, exit_code: 0, stdout: "", stderr: "", duration_ms: 1 };
		};

		const receipt = await createPostgresBackup({
			destination,
			deployment_id: "prod",
			backup_id: "backup-1",
			database_url: "postgres://admin:secret@postgres/langfuse",
			run_process,
			now: () => new Date("2026-07-24T12:00:00.000Z"),
		});

		expect(receipt.provider).toBe("postgres");
		expect(receipt.client_version).toBe("17.5");
		expect(receipt.server_version).toBe("17.5");
		expect(receipt.sha256).toMatch(/^[a-f0-9]{64}$/);
		expect(objects.get(receipt.object_path)?.toString()).toBe("custom-format-dump");
	});
});
