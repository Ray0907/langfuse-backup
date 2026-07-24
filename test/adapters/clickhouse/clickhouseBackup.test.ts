import { describe, expect, it } from "vitest";

import {
	createClickhouseBackup,
	type ClickhouseQuery,
} from "../../../src/adapters/clickhouse/clickhouseBackup.js";

interface QueryFixtureOptions {
	statuses?: string[];
}

function createQueryFixture(options: QueryFixtureOptions = {}): {
	query: ClickhouseQuery;
	sql: string[];
} {
	const sql: string[] = [];
	const statuses = options.statuses ?? ["BACKUP_CREATED"];
	let index_status = 0;

	return {
		sql,
		async query(text_query) {
			sql.push(text_query);
			if (text_query.includes("version()")) {
				return { data: [{ version: "25.7.1.1" }] };
			}
			if (text_query.includes("system.backups")) {
				const status = statuses[Math.min(index_status, statuses.length - 1)];
				index_status += 1;
				return {
					data: [{
						status,
						error: status === "BACKUP_FAILED" ? "provider failed" : "",
						num_files: "12",
						total_size: "4096",
					}],
				};
			}
			return { data: [] };
		},
	};
}

describe("createClickhouseBackup", () => {
	it("prefers a named collection and records provider evidence", async () => {
		const fixture_query = createQueryFixture();

		const receipt = await createClickhouseBackup({
			query: fixture_query.query,
			deployment_id: "prod",
			backup_id: "backup-1",
			database: "default",
			named_collection: "langfuse_backup",
			s3_endpoint: "https://storage.googleapis.com/bucket",
			hmac_access_key: "inline-access",
			hmac_secret_key: "inline-secret",
			create_operation_id: () => "operation-1",
			sleep: async () => undefined,
			now: () => new Date("2026-07-24T12:00:00.000Z"),
		});

		const sql_backup = fixture_query.sql.find((text_query) =>
			text_query.startsWith("BACKUP DATABASE"));
		expect(sql_backup).toContain("langfuse_backup");
		expect(sql_backup).not.toContain("inline-access");
		expect(sql_backup).not.toContain("inline-secret");
		expect(receipt).toMatchObject({
			provider: "clickhouse",
			operation_id: "operation-1",
			database: "default",
			status: "BACKUP_CREATED",
			size_bytes: 4096,
			server_version: "25.7.1.1",
		});
		expect(receipt.object_prefix).toContain("prod/backups/backup-1/clickhouse");
	});

	it("uses a distinct remote prefix for each backup ID", async () => {
		const fixture_first = createQueryFixture();
		const fixture_second = createQueryFixture();
		const options_base = {
			deployment_id: "prod",
			database: "default",
			named_collection: "langfuse_backup",
			create_operation_id: () => "operation",
			sleep: async () => undefined,
			now: () => new Date("2026-07-24T12:00:00.000Z"),
		};

		const receipt_first = await createClickhouseBackup({
			...options_base,
			query: fixture_first.query,
			backup_id: "backup-1",
		});
		const receipt_second = await createClickhouseBackup({
			...options_base,
			query: fixture_second.query,
			backup_id: "backup-2",
		});

		expect(receipt_first.object_prefix).not.toBe(receipt_second.object_prefix);
	});

	it.each([
		"BACKUP_FAILED",
		"BACKUP_CANCELLED",
		"UNKNOWN",
	])("rejects terminal status %s", async (status_backup) => {
		const fixture_query = createQueryFixture({ statuses: [status_backup] });

		await expect(createClickhouseBackup({
			query: fixture_query.query,
			deployment_id: "prod",
			backup_id: "backup-1",
			database: "default",
			named_collection: "langfuse_backup",
			create_operation_id: () => "operation-1",
			sleep: async () => undefined,
			now: () => new Date("2026-07-24T12:00:00.000Z"),
		})).rejects.toThrow(new RegExp(status_backup, "i"));
	});

	it("rejects an operation that never reaches a terminal status", async () => {
		const fixture_query = createQueryFixture({
			statuses: ["CREATING_BACKUP", "CREATING_BACKUP"],
		});

		await expect(createClickhouseBackup({
			query: fixture_query.query,
			deployment_id: "prod",
			backup_id: "backup-1",
			database: "default",
			named_collection: "langfuse_backup",
			create_operation_id: () => "operation-1",
			max_poll_attempts: 2,
			sleep: async () => undefined,
			now: () => new Date("2026-07-24T12:00:00.000Z"),
		})).rejects.toThrow(/timed out/i);
	});
});
