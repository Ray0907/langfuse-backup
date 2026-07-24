import { Command } from "commander";

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

function addPlaceholder(program: Command, name_command: string, description: string): void {
	program
		.command(name_command)
		.description(description)
		.action(() => {
			throw new CliError(
				"NOT_IMPLEMENTED",
				`${name_command} is not implemented yet`,
				2,
			);
		});
}

export function createProgram(io_cli: CliIo = {
	write_output: (value_output) => process.stdout.write(value_output),
	write_error: (value_error) => process.stderr.write(value_error),
}): Command {
	const program = new Command();
	program
		.name("langfuse-backup")
		.description("Verifiable backup and restore for self-hosted Langfuse")
		.version("0.1.0")
		.configureOutput({
			writeOut: io_cli.write_output,
			writeErr: io_cli.write_error,
		});

	addPlaceholder(program, "doctor", "Check source and destination prerequisites");
	addPlaceholder(program, "create", "Create a recovery point");
	addPlaceholder(program, "list", "List committed recovery points");
	addPlaceholder(program, "inspect", "Inspect a committed recovery point");
	addPlaceholder(program, "verify", "Verify recovery-point artifacts");
	addPlaceholder(program, "restore", "Plan or run an isolated restore");

	return program;
}
