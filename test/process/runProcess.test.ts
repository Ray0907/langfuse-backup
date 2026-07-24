import { describe, expect, it, vi } from "vitest";

import type { Logger } from "../../src/logging/logger.js";
import { runProcess } from "../../src/process/runProcess.js";

function createLoggerSpy(): { logger: Logger; entries: string[] } {
	const entries: string[] = [];
	const write_entry = (message: string, context?: Record<string, unknown>) => {
		entries.push(JSON.stringify({ message, ...context }));
	};
	return {
		entries,
		logger: {
			debug: write_entry,
			info: write_entry,
			warn: write_entry,
			error: write_entry,
		},
	};
}

describe("runProcess", () => {
	it("captures stdout and stderr on success", async () => {
		const result_process = await runProcess(process.execPath, [
			"-e",
			"process.stdout.write('out'); process.stderr.write('warn')",
		]);

		expect(result_process).toMatchObject({
			exit_code: 0,
			stdout: "out",
			stderr: "warn",
		});
	});

	it("preserves exit code and redacted stderr on failure", async () => {
		await expect(runProcess(process.execPath, [
			"-e",
			"process.stderr.write('postgres://admin:dbpass@db/app'); process.exit(7)",
		])).rejects.toMatchObject({
			exit_code: 7,
			stderr: expect.not.stringContaining("dbpass") as string,
		});
	});

	it("times out and terminates a process", async () => {
		await expect(runProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
			timeout_ms: 50,
		})).rejects.toMatchObject({ timed_out: true });
	});

	it("honors cancellation", async () => {
		const controller_abort = new AbortController();
		const promise_process = runProcess(
			process.execPath,
			["-e", "setInterval(() => {}, 1000)"],
			{ signal: controller_abort.signal },
		);
		controller_abort.abort();

		await expect(promise_process).rejects.toMatchObject({ cancelled: true });
	});

	it("never logs secret-bearing command arguments", async () => {
		const { logger, entries } = createLoggerSpy();
		const secret_value = "postgres://admin:dbpass@db/app";
		await runProcess(process.execPath, ["-e", "process.exit(0)", secret_value], { logger });

		expect(entries.join("\n")).not.toContain(secret_value);
		expect(entries.join("\n")).not.toContain("dbpass");
		expect(vi.isMockFunction(logger.info)).toBe(false);
	});
});
