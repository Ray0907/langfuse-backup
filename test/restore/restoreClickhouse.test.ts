import { describe, expect, it, vi } from "vitest";

import type { ClickhouseReceipt } from "../../src/manifest/schema.js";
import type { ClickhouseQuery } from "../../src/adapters/clickhouse/queryBackupStatus.js";
import { restoreClickhouse } from "../../src/restore/restoreClickhouse.js";

const receipt_clickhouse: ClickhouseReceipt = {
	provider: "clickhouse",
	operation_id: "backup-operation",
	database: "default",
	object_prefix: "deployments/source/backups/backup-1/clickhouse/backup-operation",
	status: "BACKUP_CREATED",
	size_bytes: 200,
	started_at: "2026-07-24T12:00:00.000Z",
	completed_at: "2026-07-24T12:01:00.000Z",
	verified_at: "2026-07-24T12:01:01.000Z",
	server_version: "25.7.1.1",
};

function createQuery(statuses: string[]): {
	query: ClickhouseQuery;
	queries: string[];
} {
	const queries: string[] = [];
	let index_status = 0;
	return {
		queries,
		query: async (text_query) => {
			queries.push(text_query);
			if (text_query.includes("version()")) {
				return { data: [{ version: "25.7.4.1" }] };
			}
			if (text_query.includes("system.backups")) {
				const status = statuses[index_status++] ?? statuses.at(-1) ?? "UNKNOWN";
				return {
					data: [{
						status,
						error: status.includes("FAILED") ? "restore failed" : "",
						num_files: "3",
						total_size: "200",
					}],
				};
			}
			return { data: [] };
		},
	};
}

describe("restoreClickhouse", () => {
	it("issues native RESTORE and records only a RESTORED operation", async () => {
		const { query, queries } = createQuery(["RESTORING", "RESTORED"]);
		const evidence_seen: unknown[] = [];

		const evidence = await restoreClickhouse({
			query,
			receipt: receipt_clickhouse,
			named_collection: "langfuse_backup",
			check_target_empty: async () => true,
			create_operation_id: () => "restore-operation",
			sleep: async () => undefined,
			write_journal: async (entry_evidence) => {
				evidence_seen.push(entry_evidence);
			},
		});

		expect(queries.some((text_query) =>
			text_query.startsWith("RESTORE DATABASE"))).toBe(true);
		expect(queries.join("\n")).toContain("langfuse_backup");
		expect(queries.join("\n")).toContain(receipt_clickhouse.object_prefix);
		expect(evidence).toMatchObject({
			operation_id: "restore-operation",
			status: "RESTORED",
			server_version: "25.7.4.1",
		});
		expect(evidence_seen).toEqual([evidence]);
	});

	it("confirms the target database is empty before issuing SQL", async () => {
		const query = vi.fn<ClickhouseQuery>();

		await expect(restoreClickhouse({
			query,
			receipt: receipt_clickhouse,
			named_collection: "langfuse_backup",
			check_target_empty: async () => false,
		})).rejects.toThrow(/target.*not empty/i);
		expect(query).not.toHaveBeenCalled();
	});

	it.each([
		"RESTORE_FAILED",
		"RESTORE_CANCELLED",
		"PARTIALLY_RESTORED",
		"UNKNOWN",
	])("rejects terminal or unknown status %s", async (status_restore) => {
		const { query } = createQuery([status_restore]);

		await expect(restoreClickhouse({
			query,
			receipt: receipt_clickhouse,
			named_collection: "langfuse_backup",
			check_target_empty: async () => true,
			max_poll_attempts: 1,
		})).rejects.toThrow(new RegExp(status_restore));
	});

	it("rejects timed-out restore operations", async () => {
		const { query } = createQuery(["RESTORING"]);

		await expect(restoreClickhouse({
			query,
			receipt: receipt_clickhouse,
			named_collection: "langfuse_backup",
			check_target_empty: async () => true,
			max_poll_attempts: 2,
			sleep: async () => undefined,
		})).rejects.toThrow(/timed out/i);
	});
});
