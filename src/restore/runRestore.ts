import { redactValue } from "../logging/redact.js";
import type { RestorePlan } from "./restorePlan.js";

export type RestoreWorkStage =
	| "blob"
	| "postgres"
	| "clickhouse"
	| "health_checks"
	| "smoke_tests"
	| "report";

export type RestoreStage =
	| "plan"
	| "confirmation"
	| "target_lock"
	| RestoreWorkStage
	| "target_unlock";

export interface RestoreJournal {
	backup_id: string;
	target_deployment_id: string;
	status: "running" | "dirty" | "complete";
	completed_stages: RestoreWorkStage[];
	updated_at: string;
	error?: string;
	report_path?: string;
}

export interface RunRestoreOptions {
	create_plan: () => Promise<RestorePlan>;
	target_config_path: string;
	confirm: boolean;
	expected_backup_id: string;
	acquire_target_lock: () => Promise<unknown>;
	release_target_lock: (lock_target: unknown) => Promise<void>;
	read_journal: () => Promise<RestoreJournal | null>;
	write_journal: (journal_restore: RestoreJournal) => Promise<void>;
	restore_blob: () => Promise<unknown>;
	restore_postgres: () => Promise<unknown>;
	restore_clickhouse: () => Promise<unknown>;
	run_health_checks: () => Promise<void>;
	run_smoke_tests: () => Promise<void>;
	write_report: () => Promise<string>;
	on_stage?: (stage_restore: RestoreStage) => void | Promise<void>;
	now?: () => Date;
}

export interface RunRestoreResult {
	plan: RestorePlan;
	journal: RestoreJournal;
	report_path: string;
}

function assertConfirmation(options: RunRestoreOptions, plan_restore: RestorePlan): void {
	if (options.target_config_path.trim() === "") {
		throw new Error("Restore requires --target <config>");
	}
	if (options.confirm !== true) {
		throw new Error("Restore requires --confirm");
	}
	if (options.expected_backup_id.trim() === "") {
		throw new Error("Restore requires --expected-backup-id");
	}
	if (options.expected_backup_id !== plan_restore.backup_id) {
		throw new Error(
			`Expected backup ID mismatch: ${options.expected_backup_id} `
			+ `does not equal ${plan_restore.backup_id}`,
		);
	}
}

function getErrorMessage(error: unknown): string {
	const message_error = error instanceof Error ? error.message : String(error);
	const value_redacted = redactValue(message_error);
	return typeof value_redacted === "string" ? value_redacted : "[REDACTED]";
}

async function reportStage(
	options: RunRestoreOptions,
	stage_restore: RestoreStage,
): Promise<void> {
	await options.on_stage?.(stage_restore);
}

export async function runRestore(
	options: RunRestoreOptions,
): Promise<RunRestoreResult> {
	const plan_restore = await options.create_plan();
	await reportStage(options, "plan");
	assertConfirmation(options, plan_restore);
	await reportStage(options, "confirmation");

	const journal_existing = await options.read_journal();
	if (journal_existing !== null
		&& journal_existing.backup_id !== plan_restore.backup_id) {
		throw new Error("Dirty restore target belongs to a different backup");
	}

	const get_now = options.now ?? (() => new Date());
	let journal_restore: RestoreJournal = {
		...(journal_existing ?? {
			backup_id: plan_restore.backup_id,
			target_deployment_id: plan_restore.target_deployment_id,
			completed_stages: [],
		}),
		status: "running",
		updated_at: get_now().toISOString(),
	};
	const lock_target = await options.acquire_target_lock();
	try {
		await reportStage(options, "target_lock");
		await options.write_journal(journal_restore);
		const steps_restore: Array<{
			stage: RestoreWorkStage;
			run: () => Promise<unknown>;
		}> = [
			{ stage: "blob", run: options.restore_blob },
			{ stage: "postgres", run: options.restore_postgres },
			{ stage: "clickhouse", run: options.restore_clickhouse },
			{ stage: "health_checks", run: options.run_health_checks },
			{ stage: "smoke_tests", run: options.run_smoke_tests },
			{ stage: "report", run: options.write_report },
		];
		let report_path = journal_restore.report_path ?? "";

		for (const step_restore of steps_restore) {
			if (journal_restore.completed_stages.includes(step_restore.stage)) {
				continue;
			}
			const result_step = await step_restore.run();
			if (step_restore.stage === "report") {
				report_path = String(result_step);
				journal_restore.report_path = report_path;
			}
			journal_restore.completed_stages.push(step_restore.stage);
			journal_restore.updated_at = get_now().toISOString();
			await options.write_journal(journal_restore);
			await reportStage(options, step_restore.stage);
		}
		journal_restore = {
			...journal_restore,
			status: "complete",
			updated_at: get_now().toISOString(),
		};
		delete journal_restore.error;
		await options.write_journal(journal_restore);
		return { plan: plan_restore, journal: journal_restore, report_path };
	} catch (error) {
		journal_restore = {
			...journal_restore,
			status: "dirty",
			updated_at: get_now().toISOString(),
			error: getErrorMessage(error),
		};
		await options.write_journal(journal_restore);
		throw error;
	} finally {
		await options.release_target_lock(lock_target);
		await reportStage(options, "target_unlock");
	}
}
