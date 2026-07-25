import { describe, expect, it, vi } from "vitest";

import type { RestorePlan } from "../../src/restore/restorePlan.js";
import {
	runRestore,
	type RestoreJournal,
	type RestoreStage,
} from "../../src/restore/runRestore.js";

function createPlan(backup_id = "backup-1"): RestorePlan {
	return {
		backup_id,
		source_deployment_id: "source",
		target_deployment_id: "target",
		requires_downtime: true,
		estimated_artifact_size_bytes: 600,
		required_secrets: [],
		version_checks: [],
		actions: [],
	};
}

function createOptions(overrides: Record<string, unknown> = {}) {
	let journal_saved: RestoreJournal | null = null;
	const stages_seen: RestoreStage[] = [];
	const options = {
		create_plan: async () => createPlan(),
		target_config_path: "target.yaml",
		confirm: true,
		expected_backup_id: "backup-1",
		acquire_target_lock: async () => ({ generation: 1 }),
		release_target_lock: async () => undefined,
		read_journal: async () => journal_saved,
		write_journal: async (journal_restore: RestoreJournal) => {
			journal_saved = structuredClone(journal_restore);
		},
		restore_blob: async () => ({ object_count: 2 }),
		restore_postgres: async () => ({ restored: true }),
		restore_clickhouse: async () => ({ status: "RESTORED" }),
		run_health_checks: async () => undefined,
		run_smoke_tests: async () => undefined,
		write_report: async () => "restore-report.json",
		on_stage: (stage_restore: RestoreStage) => {
			stages_seen.push(stage_restore);
		},
		...overrides,
	};
	return {
		options,
		stages_seen,
		getJournal: () => journal_saved,
	};
}

describe("runRestore", () => {
	it("orders an explicitly confirmed restore and marks the journal complete", async () => {
		const { options, stages_seen, getJournal } = createOptions();

		const result_restore = await runRestore(options);

		expect(stages_seen).toEqual([
			"plan",
			"confirmation",
			"target_lock",
			"blob",
			"postgres",
			"clickhouse",
			"health_checks",
			"smoke_tests",
			"report",
			"target_unlock",
		]);
		expect(result_restore.journal.status).toBe("complete");
		expect(result_restore.report_path).toBe("restore-report.json");
		expect(getJournal()?.completed_stages).toEqual([
			"blob",
			"postgres",
			"clickhouse",
			"health_checks",
			"smoke_tests",
			"report",
		]);
	});

	it.each([
		["target_config_path", "", /--target/i],
		["confirm", false, /--confirm/i],
		["expected_backup_id", "", /--expected-backup-id/i],
		["expected_backup_id", "different", /expected backup.*mismatch/i],
	] as const)("rejects missing or invalid %s before locking", async (
		field_option,
		value_option,
		pattern_error,
	) => {
		const acquire_target_lock = vi.fn(async () => ({ generation: 1 }));
		const { options } = createOptions({
			[field_option]: value_option,
			acquire_target_lock,
		});

		await expect(runRestore(options)).rejects.toThrow(pattern_error);
		expect(acquire_target_lock).not.toHaveBeenCalled();
	});

	it("marks failures dirty and always releases the target lock", async () => {
		const release_target_lock = vi.fn(async () => undefined);
		const { options, getJournal } = createOptions({
			restore_postgres: async () => {
				throw new Error("PostgreSQL restore failed");
			},
			release_target_lock,
		});

		await expect(runRestore(options)).rejects.toThrow(/PostgreSQL restore failed/);
		expect(getJournal()).toMatchObject({
			backup_id: "backup-1",
			status: "dirty",
			completed_stages: ["blob"],
			error: "PostgreSQL restore failed",
		});
		expect(release_target_lock).toHaveBeenCalledOnce();
	});

	it("releases the target lock when initial journal persistence fails", async () => {
		const release_target_lock = vi.fn(async () => undefined);
		const { options } = createOptions({
			write_journal: async () => {
				throw new Error("journal unavailable");
			},
			release_target_lock,
		});

		await expect(runRestore(options)).rejects.toThrow(/journal unavailable/);
		expect(release_target_lock).toHaveBeenCalledOnce();
	});

	it("refuses to resume a dirty target with a different backup", async () => {
		const acquire_target_lock = vi.fn(async () => ({ generation: 1 }));
		const { options } = createOptions({
			create_plan: async () => createPlan("backup-2"),
			expected_backup_id: "backup-2",
			read_journal: async () => ({
				backup_id: "backup-1",
				target_deployment_id: "target",
				status: "dirty",
				completed_stages: ["blob"],
				updated_at: "2026-07-24T12:00:00.000Z",
			}),
			acquire_target_lock,
		});

		await expect(runRestore(options)).rejects.toThrow(/different backup/i);
		expect(acquire_target_lock).not.toHaveBeenCalled();
	});

	it("resumes the same backup without repeating completed destructive stages", async () => {
		const restore_blob = vi.fn(async () => undefined);
		const restore_postgres = vi.fn(async () => undefined);
		const { options } = createOptions({
			read_journal: async () => ({
				backup_id: "backup-1",
				target_deployment_id: "target",
				status: "dirty",
				completed_stages: ["blob"],
				updated_at: "2026-07-24T12:00:00.000Z",
			}),
			restore_blob,
			restore_postgres,
		});

		await runRestore(options);

		expect(restore_blob).not.toHaveBeenCalled();
		expect(restore_postgres).toHaveBeenCalledOnce();
	});
});
