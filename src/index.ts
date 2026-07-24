import { CliError, createProgram } from "./cli.js";

async function runCli(): Promise<void> {
	try {
		await createProgram().parseAsync(process.argv);
	} catch (error) {
		if (error instanceof CliError) {
			process.stderr.write(`${error.code_error}: ${error.message}\n`);
			process.exitCode = error.code_exit;
			return;
		}

		throw error;
	}
}

void runCli();
