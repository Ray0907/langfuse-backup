import type { ProcessResult, ProcessRunner } from "../process/runProcess.js";
import { runProcess } from "../process/runProcess.js";

export interface RunHookOptions {
	command: string[];
	timeout_ms?: number;
	shell?: boolean;
	container_mode?: boolean;
	allow_container_hooks?: boolean;
	run_process?: ProcessRunner;
}

export async function runHook(options: RunHookOptions): Promise<ProcessResult> {
	if (options.command.length === 0) {
		throw new Error("Hook command cannot be empty");
	}
	const container_mode = options.container_mode
		?? process.env.LANGFUSE_BACKUP_CONTAINER === "true";
	if (container_mode && options.allow_container_hooks !== true) {
		throw new Error("Hooks are disabled inside the container by default");
	}

	const run_process = options.run_process ?? runProcess;
	const command_hook = options.command[0];
	if (command_hook === undefined) {
		throw new Error("Hook command cannot be empty");
	}
	const use_shell = options.shell === true;
	const command_process = use_shell ? "/bin/sh" : command_hook;
	const arguments_process = use_shell
		? ["-c", options.command.join(" ")]
		: options.command.slice(1);
	const process_options = options.timeout_ms === undefined
		? {}
		: { timeout_ms: options.timeout_ms };

	return run_process(command_process, arguments_process, process_options);
}
