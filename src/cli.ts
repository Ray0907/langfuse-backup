import { Command } from "commander";

import {
	runCreateRuntime,
	runDoctorRuntime,
	runInspectRuntime,
	runListRuntime,
	runPruneRuntime,
	runVerifyRuntime,
	type CreateRuntimeOptions,
	type PruneRuntimeOptions,
} from "./runtime/backupRuntime.js";
import {
	runRestorePlanRuntime,
	runRestoreRuntime,
	type RestorePlanRuntimeOptions,
	type RestoreRuntimeOptions,
} from "./runtime/restoreRuntime.js";
import { getVersionText } from "./version.js";

export interface CliIo {
	write_output: (value_output: string) => void;
	write_error: (value_error: string) => void;
}

export class CliError extends Error {
	public readonly code_error: string;
	public readonly code_exit: number;

	public constructor(code_error: string, message: string, code_exit = 1) {
		super(message);
		this.name = "CliError";
		this.code_error = code_error;
		this.code_exit = code_exit;
	}
}

export interface CliRuntime {
	doctor: (path_config: string) => Promise<unknown>;
	create: (options: CreateRuntimeOptions) => Promise<unknown>;
	list: (path_config: string) => Promise<unknown>;
	inspect: (path_config: string, backup_id: string) => Promise<unknown>;
	verify: (path_config: string, backup_id: string) => Promise<unknown>;
	prune: (options: PruneRuntimeOptions) => Promise<unknown>;
	restore_plan: (options: RestorePlanRuntimeOptions) => Promise<unknown>;
	restore_run: (options: RestoreRuntimeOptions) => Promise<unknown>;
}

const runtime_default: CliRuntime = {
	doctor: runDoctorRuntime,
	create: runCreateRuntime,
	list: runListRuntime,
	inspect: runInspectRuntime,
	verify: runVerifyRuntime,
	prune: runPruneRuntime,
	restore_plan: runRestorePlanRuntime,
	restore_run: runRestoreRuntime,
};

function writeResult(io_cli: CliIo, result_command: unknown): void {
	const text_result = typeof result_command === "string"
		? result_command
		: `${JSON.stringify(result_command, null, 2)}\n`;
	io_cli.write_output(text_result.endsWith("\n") ? text_result : `${text_result}\n`);
}

function parseCount(value_count: string): number {
	const count_parsed = Number(value_count);
	if (!Number.isSafeInteger(count_parsed) || count_parsed < 0) {
		throw new CliError("INVALID_ARGUMENT", "Retention counts must be non-negative integers", 2);
	}
	return count_parsed;
}

export function createProgram(io_cli: CliIo = {
	write_output: (value_output) => process.stdout.write(value_output),
	write_error: (value_error) => process.stderr.write(value_error),
}, runtime_cli: CliRuntime = runtime_default): Command {
	const program = new Command();
	program
		.name("langfuse-backup")
		.description("Verifiable backup and restore for self-hosted Langfuse")
		.version(getVersionText())
		.configureOutput({
			writeOut: io_cli.write_output,
			writeErr: io_cli.write_error,
		});

	program
		.command("doctor")
		.description("Check source and destination prerequisites")
		.requiredOption("--config <path>", "Backup configuration")
		.action(async (options_command: { config: string }) => {
			writeResult(io_cli, await runtime_cli.doctor(options_command.config));
		});
	program
		.command("create")
		.description("Create a recovery point")
		.requiredOption("--config <path>", "Backup configuration")
		.option("--backup-id <id>", "Stable recovery-point ID")
		.option("--allow-active-writes", "Accept online consistency")
		.option("--allow-container-hooks", "Allow configured hooks in the OCI image")
		.option("--takeover-expired-lock", "Take over a verified expired backup lock")
		.action(async (options_command: {
			config: string;
			backupId?: string;
			allowActiveWrites?: boolean;
			allowContainerHooks?: boolean;
			takeoverExpiredLock?: boolean;
		}) => {
			writeResult(io_cli, await runtime_cli.create({
				path_config: options_command.config,
				...(options_command.backupId === undefined
					? {}
					: { backup_id: options_command.backupId }),
				allow_active_writes: options_command.allowActiveWrites === true,
				allow_container_hooks: options_command.allowContainerHooks === true,
				takeover_expired_lock: options_command.takeoverExpiredLock === true,
			}));
		});
	program
		.command("list")
		.description("List committed recovery points")
		.requiredOption("--config <path>", "Backup configuration")
		.action(async (options_command: { config: string }) => {
			writeResult(io_cli, await runtime_cli.list(options_command.config));
		});
	program
		.command("inspect")
		.description("Inspect a committed recovery point")
		.requiredOption("--config <path>", "Backup configuration")
		.requiredOption("--backup-id <id>", "Committed backup ID")
		.action(async (options_command: { config: string; backupId: string }) => {
			writeResult(
				io_cli,
				await runtime_cli.inspect(options_command.config, options_command.backupId),
			);
		});
	program
		.command("verify")
		.description("Verify recovery-point artifacts")
		.requiredOption("--config <path>", "Backup configuration")
		.requiredOption("--backup-id <id>", "Committed backup ID")
		.action(async (options_command: { config: string; backupId: string }) => {
			writeResult(
				io_cli,
				await runtime_cli.verify(options_command.config, options_command.backupId),
			);
		});
	program
		.command("prune")
		.description("Plan or confirm recovery-point retention")
		.requiredOption("--config <path>", "Backup configuration")
		.option("--keep-daily <count>", "Daily recovery points to retain", parseCount, 7)
		.option("--keep-weekly <count>", "Weekly recovery points to retain", parseCount, 4)
		.option("--confirm", "Delete the selected committed recovery points")
		.action(async (options_command: {
			config: string;
			keepDaily: number;
			keepWeekly: number;
			confirm?: boolean;
		}) => {
			writeResult(io_cli, await runtime_cli.prune({
				path_config: options_command.config,
				keep_daily: options_command.keepDaily,
				keep_weekly: options_command.keepWeekly,
				confirm: options_command.confirm === true,
			}));
		});
	const command_restore = program
		.command("restore")
		.description("Plan or run an isolated restore");
	command_restore
		.command("plan")
		.description("Print a read-only restore plan")
		.requiredOption("--config <path>", "Source backup configuration")
		.requiredOption("--target <path>", "Separate target configuration")
		.requiredOption("--backup-id <id>", "Committed backup ID")
		.option("--accept-online-consistency", "Accept a non-coordinated backup")
		.action(async (options_command: {
			config: string;
			target: string;
			backupId: string;
			acceptOnlineConsistency?: boolean;
		}) => {
			writeResult(io_cli, await runtime_cli.restore_plan({
				path_config: options_command.config,
				path_target: options_command.target,
				backup_id: options_command.backupId,
				accept_online_consistency: options_command.acceptOnlineConsistency === true,
			}));
		});
	command_restore
		.command("run")
		.description("Run an explicitly confirmed restore")
		.requiredOption("--config <path>", "Source backup configuration")
		.requiredOption("--target <path>", "Separate target configuration")
		.requiredOption("--expected-backup-id <id>", "Exact committed backup ID")
		.option("--confirm", "Confirm destructive target writes")
		.option("--accept-online-consistency", "Accept a non-coordinated backup")
		.option("--allow-container-hooks", "Allow target checks in the OCI image")
		.action(async (options_command: {
			config: string;
			target: string;
			expectedBackupId: string;
			confirm?: boolean;
			acceptOnlineConsistency?: boolean;
			allowContainerHooks?: boolean;
		}) => {
			if (options_command.confirm !== true) {
				throw new CliError(
					"CONFIRMATION_REQUIRED",
					"restore run requires --confirm",
					2,
				);
			}
			writeResult(io_cli, await runtime_cli.restore_run({
				path_config: options_command.config,
				path_target: options_command.target,
				expected_backup_id: options_command.expectedBackupId,
				confirm: true,
				accept_online_consistency: options_command.acceptOnlineConsistency === true,
				allow_container_hooks: options_command.allowContainerHooks === true,
			}));
		});

	return program;
}
