import { describe, expect, it } from "vitest";

import { runHook } from "../../src/orchestration/runHook.js";
import type { ProcessRunner } from "../../src/process/runProcess.js";

describe("runHook", () => {
	it("disables hooks inside the OCI image by default", async () => {
		await expect(runHook({
			command: ["/usr/local/bin/block-ingestion"],
			container_mode: true,
		})).rejects.toThrow(/disabled.*container/i);
	});

	it("runs host commands without a shell by default", async () => {
		const calls_process: Array<{ command: string; arguments_process: string[] }> = [];
		const run_process: ProcessRunner = async (command, arguments_process) => {
			calls_process.push({ command, arguments_process });
			return {
				command,
				exit_code: 0,
				stdout: "blocked",
				stderr: "",
				duration_ms: 1,
			};
		};

		await runHook({
			command: ["/usr/local/bin/block-ingestion", "--deployment", "prod"],
			run_process,
		});

		expect(calls_process).toEqual([{
			command: "/usr/local/bin/block-ingestion",
			arguments_process: ["--deployment", "prod"],
		}]);
	});

	it("preserves timeout output from the process runner", async () => {
		const error_timeout = Object.assign(new Error("hook timed out"), {
			stdout: "partial output",
			stderr: "cleanup needed",
			timed_out: true,
		});
		const run_process: ProcessRunner = async () => {
			throw error_timeout;
		};

		await expect(runHook({
			command: ["/usr/local/bin/block-ingestion"],
			run_process,
			timeout_ms: 10,
		})).rejects.toBe(error_timeout);
	});
});
