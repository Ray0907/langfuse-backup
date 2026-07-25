import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

import type {
	ProcessResult,
	ProcessRunner,
} from "../../../src/process/runProcess.js";

interface RunBinaryOptions {
	env?: NodeJS.ProcessEnv;
	input?: Buffer;
	timeout_ms?: number;
}

export interface BinaryResult {
	stdout: Buffer;
	stderr: string;
}

export async function runBinary(
	command: string,
	arguments_process: string[],
	options: RunBinaryOptions = {},
): Promise<BinaryResult> {
	return new Promise((resolve, reject) => {
		const child_process = spawn(command, arguments_process, {
			env: options.env ?? process.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		const chunks_stdout: Buffer[] = [];
		const chunks_stderr: Buffer[] = [];
		const timer_timeout = setTimeout(() => {
			child_process.kill("SIGTERM");
		}, options.timeout_ms ?? 120_000);
		child_process.stdout.on("data", (chunk_data: Buffer) =>
			chunks_stdout.push(chunk_data));
		child_process.stderr.on("data", (chunk_data: Buffer) =>
			chunks_stderr.push(chunk_data));
		child_process.once("error", reject);
		child_process.once("close", (code_exit) => {
			clearTimeout(timer_timeout);
			const stderr = Buffer.concat(chunks_stderr).toString("utf8");
			if (code_exit !== 0) {
				reject(new Error(
					`${command} exited with ${String(code_exit)}: ${stderr}`,
				));
				return;
			}
			resolve({ stdout: Buffer.concat(chunks_stdout), stderr });
		});
		child_process.stdin.end(options.input);
	});
}

export async function runText(
	command: string,
	arguments_process: string[],
	options: RunBinaryOptions = {},
): Promise<string> {
	const result_process = await runBinary(command, arguments_process, options);
	return result_process.stdout.toString("utf8").trim();
}

export function createComposeArgs(
	path_compose: string,
	name_project: string,
	arguments_compose: string[],
): string[] {
	return ["compose", "-p", name_project, "-f", path_compose, ...arguments_compose];
}

export function createContainerProcessRunner(options: {
	path_compose: string;
	name_project: string;
	name_service: string;
	mode: "dump" | "restore";
	env: NodeJS.ProcessEnv;
}): ProcessRunner {
	return async (
		command: string,
		arguments_process: string[],
	): Promise<ProcessResult> => {
		const time_started = performance.now();
		const arguments_exec = createComposeArgs(
			options.path_compose,
			options.name_project,
			["exec", "-T", options.name_service, command],
		);
		if (arguments_process.length === 1 && arguments_process[0] === "--version") {
			arguments_exec.push("--version");
		} else if (command === "psql") {
			arguments_exec.push(
				"-U",
				"langfuse",
				"-d",
				"langfuse",
				"-tA",
				"-c",
				"SHOW server_version",
			);
		} else {
			return runDataCommand(
				command,
				arguments_process,
				arguments_exec,
				options,
				time_started,
			);
		}
		const result_process = await runBinary("docker", arguments_exec, {
			env: options.env,
		});
		return {
			command,
			exit_code: 0,
			stdout: result_process.stdout.toString("utf8"),
			stderr: result_process.stderr,
			duration_ms: performance.now() - time_started,
		};
	};
}

async function runDataCommand(
	command: string,
	arguments_process: string[],
	arguments_exec: string[],
	options: {
		mode: "dump" | "restore";
		env: NodeJS.ProcessEnv;
	},
	time_started: number,
): Promise<ProcessResult> {
	const argument_file = arguments_process.find((value_argument) =>
		value_argument.startsWith("--file="));
	const path_file = argument_file?.slice("--file=".length)
		?? arguments_process.at(-1);
	if (path_file === undefined) {
		throw new Error(`${command} did not include a dump path`);
	}
	const arguments_forward = arguments_process
		.filter((value_argument) => value_argument !== argument_file)
		.filter((value_argument) => value_argument !== path_file)
		.filter((value_argument) => value_argument !== "--dbname")
		.filter((value_argument) => !value_argument.startsWith("postgresql://"));
	arguments_exec.push("-U", "langfuse", "-d", "langfuse", ...arguments_forward);
	const input_dump = options.mode === "restore"
		? await import("node:fs/promises").then((module_fs) =>
			module_fs.readFile(path_file))
		: undefined;
	const result_process = await runBinary("docker", arguments_exec, {
		env: options.env,
		...(input_dump === undefined ? {} : { input: input_dump }),
	});
	if (options.mode === "dump") {
		const { writeFile } = await import("node:fs/promises");
		await writeFile(path_file, result_process.stdout, { mode: 0o600 });
	}
	return {
		command,
		exit_code: 0,
		stdout: "",
		stderr: result_process.stderr,
		duration_ms: performance.now() - time_started,
	};
}
