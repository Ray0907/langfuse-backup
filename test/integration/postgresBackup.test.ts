import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createPostgresBackup } from "../../src/adapters/postgres/postgresBackup.js";
import type { BackupDestination } from "../../src/destination/types.js";

describe("PostgreSQL backup integration", () => {
	it("round-trips a closed dump artifact through the destination", async () => {
		const path_test = await mkdtemp(join(tmpdir(), "langfuse-postgres-integration-"));
		const path_binary = join(path_test, "pg-tool.mjs");
		const objects = new Map<string, Buffer>();
		const destination: BackupDestination = {
			async putObject(path_object, data_object) {
				objects.set(path_object, Buffer.from(data_object));
				const { createHash } = await import("node:crypto");
				return {
					path: path_object,
					generation: 1,
					size_bytes: data_object.length,
					sha256: createHash("sha256").update(data_object).digest("hex"),
					updated_at: new Date().toISOString(),
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
				return [];
			},
		};

		await writeFile(path_binary, `#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
const argumentFile = process.argv.find((value) => value.startsWith("--file="));
if (process.argv.includes("--version")) {
	process.stdout.write("pg_dump (PostgreSQL) 17.5");
} else if (argumentFile) {
	await writeFile(argumentFile.slice(7), "seeded-row:project-1");
} else {
	process.stdout.write("17.5");
}
`);
		await chmod(path_binary, 0o700);

		try {
			const receipt = await createPostgresBackup({
				destination,
				deployment_id: "integration",
				backup_id: "backup-1",
				database_url: "postgres://integration:secret@localhost/langfuse",
				pg_dump_path: path_binary,
				psql_path: path_binary,
			});
			const artifact = await destination.getObject(receipt.object_path);
			const path_restore = join(path_test, "restored.dump");
			await writeFile(path_restore, artifact);

			expect(await readFile(path_restore, "utf8")).toBe("seeded-row:project-1");
		} finally {
			await rm(path_test, { recursive: true, force: true });
		}
	});
});
