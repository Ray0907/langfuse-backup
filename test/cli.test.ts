import { describe, expect, it, vi } from "vitest";

import {
	createProgram,
	type CliRuntime,
} from "../src/cli.js";

function createRuntime(): CliRuntime {
	return {
		doctor: vi.fn(async () => ({ healthy: true })),
		create: vi.fn(async () => ({ backup_id: "backup-1" })),
		list: vi.fn(async () => []),
		inspect: vi.fn(async () => ({ backup_id: "backup-1" })),
		verify: vi.fn(async () => ({ verified: true })),
		prune: vi.fn(async () => ({ dry_run: true })),
		restore_plan: vi.fn(async () => ({ actions: [] })),
		restore_run: vi.fn(async () => ({ report_path: "restore/report.json" })),
	};
}

describe("CLI", () => {
	it("lists every supported top-level command", () => {
		const program = createProgram({
			write_output: () => undefined,
			write_error: () => undefined,
		});

		const text_help = program.helpInformation();
		expect(text_help).toContain("langfuse-backup");
		expect(text_help).toContain("doctor");
		expect(text_help).toContain("create");
		expect(text_help).toContain("list");
		expect(text_help).toContain("inspect");
		expect(text_help).toContain("verify");
		expect(text_help).toContain("restore");
	});

	it("exposes read-only restore planning separately from restore execution", () => {
		const program = createProgram({
			write_output: () => undefined,
			write_error: () => undefined,
		});
		const command_restore = program.commands.find((command) =>
			command.name() === "restore");

		expect(command_restore?.commands.map((command) => command.name())).toEqual([
			"plan",
			"run",
		]);
	});

	it("wires operational commands to the runtime and writes JSON", async () => {
		const runtime = createRuntime();
		let output_cli = "";
		const program = createProgram({
			write_output: (value_output) => {
				output_cli += value_output;
			},
			write_error: () => undefined,
		}, runtime);

		await program.parseAsync([
			"node",
			"langfuse-backup",
			"create",
			"--config",
			"backup.yaml",
			"--backup-id",
			"backup-1",
			"--allow-active-writes",
		]);

		expect(runtime.create).toHaveBeenCalledWith({
			path_config: "backup.yaml",
			backup_id: "backup-1",
			allow_active_writes: true,
			allow_container_hooks: false,
			takeover_expired_lock: false,
		});
		expect(JSON.parse(output_cli)).toMatchObject({ backup_id: "backup-1" });
	});

	it("passes all destructive restore confirmations to the runtime", async () => {
		const runtime = createRuntime();
		const program = createProgram({
			write_output: () => undefined,
			write_error: () => undefined,
		}, runtime);

		await program.parseAsync([
			"node",
			"langfuse-backup",
			"restore",
			"run",
			"--config",
			"source.yaml",
			"--target",
			"target.yaml",
			"--expected-backup-id",
			"backup-1",
			"--confirm",
			"--accept-online-consistency",
		]);

		expect(runtime.restore_run).toHaveBeenCalledWith({
			path_config: "source.yaml",
			path_target: "target.yaml",
			expected_backup_id: "backup-1",
			confirm: true,
			accept_online_consistency: true,
			allow_container_hooks: false,
		});
	});
});
