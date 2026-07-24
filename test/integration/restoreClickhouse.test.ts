import { createServer } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { createHttpClickhouseQuery } from
	"../../src/adapters/clickhouse/clickhouseDoctor.js";
import { restoreClickhouse } from "../../src/restore/restoreClickhouse.js";

describe("ClickHouse restore HTTP integration", () => {
	const servers_started: Array<ReturnType<typeof createServer>> = [];

	afterEach(async () => {
		await Promise.all(servers_started.map(async (server_test) => {
			await new Promise<void>((resolve, reject) => {
				server_test.close((error) => error === undefined ? resolve() : reject(error));
			});
		}));
		servers_started.length = 0;
	});

	it("makes representative traces, observations, and scores queryable", async () => {
		const queries_seen: string[] = [];
		const server_test = createServer((request, response) => {
			const chunks_body: Buffer[] = [];
			request.on("data", (chunk_data: Buffer) => chunks_body.push(chunk_data));
			request.on("end", () => {
				const text_query = Buffer.concat(chunks_body).toString("utf8");
				queries_seen.push(text_query);
				response.setHeader("content-type", "application/json");
				if (text_query.includes("version()")) {
					response.end(JSON.stringify({ data: [{ version: "25.7.4.1" }] }));
					return;
				}
				if (text_query.includes("system.backups")) {
					response.end(JSON.stringify({
						data: [{
							status: "RESTORED",
							error: "",
							num_files: "3",
							total_size: "200",
						}],
					}));
					return;
				}
				if (text_query.startsWith("SELECT count()")) {
					response.end(JSON.stringify({ data: [{ count: "1" }] }));
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
		const query = createHttpClickhouseQuery({
			endpoint: `http://127.0.0.1:${address_server.port}`,
		});

		await restoreClickhouse({
			query,
			receipt: {
				provider: "clickhouse",
				operation_id: "backup-operation",
				database: "default",
				object_prefix: "backup/clickhouse",
				status: "BACKUP_CREATED",
				size_bytes: 200,
				started_at: "2026-07-24T12:00:00.000Z",
				completed_at: "2026-07-24T12:01:00.000Z",
				verified_at: "2026-07-24T12:01:01.000Z",
				server_version: "25.7.1.1",
			},
			named_collection: "langfuse_backup",
			check_target_empty: async () => true,
			create_operation_id: () => "restore-operation",
		});
		for (const name_table of ["traces", "observations", "scores"]) {
			const result_count = await query(
				`SELECT count() AS count FROM ${name_table} FORMAT JSON`,
			);
			expect(result_count.data[0]?.count).toBe("1");
		}
		expect(queries_seen.some((text_query) =>
			text_query.startsWith("RESTORE DATABASE"))).toBe(true);
	});
});
