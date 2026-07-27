import { CliError, createProgram } from "./cli.js";
import { redactError } from "./logging/redact.js";

async function runCli(): Promise<void> {
	try {
		await createProgram().parseAsync(process.argv);
	} catch (error) {
		if (error instanceof CliError) {
			process.stderr.write(`${error.code_error}: ${error.message}\n`);
			process.exitCode = error.code_exit;
			return;
		}

		const error_redacted = redactError(error);
		process.stderr.write(`RUNTIME_ERROR: ${error_redacted.message}\n`);
		process.exitCode = 1;
	}
}

void runCli();
