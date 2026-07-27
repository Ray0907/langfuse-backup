import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

import type { Logger } from "../logging/logger.js";
import { redactText } from "../logging/redact.js";

export interface ProcessResult {
	command: string;
	exit_code: number;
	stdout: string;
	stderr: string;
	duration_ms: number;
}

export interface RunProcessOptions {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	timeout_ms?: number;
	signal?: AbortSignal;
	logger?: Logger;
}

export class ProcessError extends Error {
	public readonly command: string;
	public readonly exit_code: number | null;
	public readonly stdout: string;
	public readonly stderr: string;
	public readonly timed_out: boolean;
	public readonly cancelled: boolean;

	public constructor(
		message: string,
		result: Omit<ProcessResult, "exit_code"> & { exit_code: number | null },
		flags: { timed_out: boolean; cancelled: boolean },
	) {
		super(message);
		this.name = "ProcessError";
		this.command = result.command;
		this.exit_code = result.exit_code;
		this.stdout = result.stdout;
		this.stderr = result.stderr;
		this.timed_out = flags.timed_out;
		this.cancelled = flags.cancelled;
	}
}

export type ProcessRunner = (
	command: string,
	arguments_process: string[],
	options?: RunProcessOptions,
) => Promise<ProcessResult>;

export const runProcess: ProcessRunner = async (
	command,
	arguments_process,
	options = {},
) => {
	if (options.signal?.aborted === true) {
		throw new ProcessError(
			`Process cancelled before start: ${command}`,
			{ command, exit_code: null, stdout: "", stderr: "", duration_ms: 0 },
			{ timed_out: false, cancelled: true },
		);
	}

	return new Promise<ProcessResult>((resolve, reject) => {
		const time_started = performance.now();
		const chunks_stdout: Buffer[] = [];
		const chunks_stderr: Buffer[] = [];
		let timed_out = false;
		let cancelled = false;
		let settled = false;

		options.logger?.debug("Starting process", {
			command,
			argument_count: arguments_process.length,
		});

		const process_child = spawn(command, arguments_process, {
			cwd: options.cwd,
			env: options.env ?? process.env,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});

		const handleAbort = (): void => {
			cancelled = true;
			process_child.kill("SIGTERM");
		};
		options.signal?.addEventListener("abort", handleAbort, { once: true });

		const timer_timeout = options.timeout_ms === undefined
			? undefined
			: setTimeout(() => {
				timed_out = true;
				process_child.kill("SIGTERM");
			}, options.timeout_ms);

		process_child.stdout.on("data", (chunk_data: Buffer) => chunks_stdout.push(chunk_data));
		process_child.stderr.on("data", (chunk_data: Buffer) => chunks_stderr.push(chunk_data));

		const cleanup = (): void => {
			if (timer_timeout !== undefined) {
				clearTimeout(timer_timeout);
			}
			options.signal?.removeEventListener("abort", handleAbort);
		};

		process_child.once("error", (error) => {
			if (settled) {
				return;
			}
			settled = true;
			cleanup();
			reject(new ProcessError(
				`Unable to start process ${command}: ${redactText(error.message)}`,
				{
					command,
					exit_code: null,
					stdout: "",
					stderr: redactText(error.message),
					duration_ms: performance.now() - time_started,
				},
				{ timed_out, cancelled },
			));
		});

		process_child.once("close", (code_exit) => {
			if (settled) {
				return;
			}
			settled = true;
			cleanup();
			const result_process = {
				command,
				exit_code: code_exit,
				stdout: redactText(Buffer.concat(chunks_stdout).toString("utf8")),
				stderr: redactText(Buffer.concat(chunks_stderr).toString("utf8")),
				duration_ms: performance.now() - time_started,
			};
			options.logger?.debug("Process finished", {
				command,
				exit_code: code_exit,
				duration_ms: result_process.duration_ms,
			});

			if (code_exit === 0 && !timed_out && !cancelled) {
				resolve({ ...result_process, exit_code: 0 });
				return;
			}

			const reason_failure = timed_out
				? "timed out"
				: cancelled ? "cancelled" : `exited with code ${String(code_exit)}`;
			reject(new ProcessError(
				`Process ${command} ${reason_failure}`,
				result_process,
				{ timed_out, cancelled },
			));
		});
	});
};
