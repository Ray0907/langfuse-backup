import { describe, expect, it } from "vitest";

import { BackupState } from "../../src/orchestration/backupState.js";

function advanceToVerified(state_backup: BackupState): void {
	for (const state_next of [
		"locked",
		"preflight_passed",
		"quiesced",
		"postgres_complete",
		"clickhouse_complete",
		"blob_complete",
		"verified",
	] as const) {
		state_backup.transition(state_next);
	}
}

describe("BackupState", () => {
	it("rejects transitions that skip required states", () => {
		const state_backup = new BackupState();

		expect(() => state_backup.transition("preflight_passed"))
			.toThrow(/created.*locked/i);
	});

	it("accepts the documented state sequence", () => {
		const state_backup = new BackupState();
		for (const name_component of ["postgres", "clickhouse", "blob"] as const) {
			state_backup.recordReceipt(name_component, {
				verified_at: "2026-07-24T10:00:00.000Z",
			});
		}

		advanceToVerified(state_backup);
		state_backup.transition("committed");

		expect(state_backup.current).toBe("committed");
	});

	it("rejects commit until every required receipt is verified", () => {
		const state_backup = new BackupState();
		state_backup.recordReceipt("postgres", {
			verified_at: "2026-07-24T10:00:00.000Z",
		});
		state_backup.recordReceipt("clickhouse", {
			verified_at: "2026-07-24T10:00:00.000Z",
		});
		advanceToVerified(state_backup);

		expect(() => state_backup.transition("committed")).toThrow(/blob/i);
	});
});
