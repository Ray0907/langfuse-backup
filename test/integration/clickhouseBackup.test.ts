import { createServer } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { createClickhouseBackup } from "../../src/adapters/clickhouse/clickhouseBackup.js";
import { createHttpClickhouseQuery } from "../../src/adapters/clickhouse/clickhouseDoctor.js";

describe("ClickHouse backup HTTP integration", () => {
	const servers_started: Array<ReturnType<typeof createServer>> = [];

	afterEach(async () => {
		await Promise.all(servers_started.map(async (server_test) => {
			await new Promise<void>((resolve, reject) => {
				server_test.close((error) => error === undefined ? resolve() : reject(error));
			});
		}));
		servers_started.length = 0;
	});

	it("observes BACKUP_CREATED and a non-empty remote prefix", async () => {
		const queries_seen: string[] = [];
		const server_test = createServer((request, response) => {
			const chunks_body: Buffer[] = [];
			request.on("data", (chunk_data: Buffer) => chunks_body.push(chunk_data));
			request.on("end", () => {
				const text_query = Buffer.concat(chunks_body).toString("utf8");
				queries_seen.push(text_query);
				response.setHeader("content-type", "application/json");
				if (text_query.includes("version()")) {
					response.end(JSON.stringify({ data: [{ version: "25.7.1.1" }] }));
					return;
				}
				if (text_query.includes("system.backups")) {
					response.end(JSON.stringify({
						data: [{
							status: "BACKUP_CREATED",
							error: "",
							num_files: "3",
							total_size: "2048",
						}],
					}));
					return;
				}
				response.end(JSON.stringify({ data: [] }));
			});
		});
		servers_started.push(server_test);
		await new Promise<void>((resolve) => server_test.listen(0, "127.0.0.1", resolve));
		const address_server = server_test.address();
		if (address_server === null || typeof address_server === "string") {
			throw new Error("Test server did not expose a TCP address");
		}

		const receipt = await createClickhouseBackup({
			query: createHttpClickhouseQuery({
				endpoint: `http://127.0.0.1:${address_server.port}`,
			}),
			deployment_id: "integration",
			backup_id: "backup-1",
			database: "default",
			named_collection: "langfuse_backup",
			create_operation_id: () => "operation-integration",
			sleep: async () => undefined,
		});

		expect(receipt.status).toBe("BACKUP_CREATED");
		expect(receipt.object_prefix.length).toBeGreaterThan(0);
		expect(queries_seen.some((text_query) =>
			text_query.startsWith("BACKUP DATABASE"))).toBe(true);
	});
});
