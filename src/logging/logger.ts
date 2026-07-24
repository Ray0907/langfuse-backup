import { redactValue } from "./redact.js";

export interface Logger {
	debug: (message: string, context?: Record<string, unknown>) => void;
	info: (message: string, context?: Record<string, unknown>) => void;
	warn: (message: string, context?: Record<string, unknown>) => void;
	error: (message: string, context?: Record<string, unknown>) => void;
}

type LogLevel = "debug" | "info" | "warn" | "error";

export function createLogger(
	write_log: (line_log: string) => void = (line_log) => process.stderr.write(line_log),
): Logger {
	function writeEntry(
		level_log: LogLevel,
		message: string,
		context: Record<string, unknown> = {},
	): void {
		const entry_log = redactValue({
			timestamp: new Date().toISOString(),
			level: level_log,
			message,
			...context,
		});
		write_log(`${JSON.stringify(entry_log)}\n`);
	}

	return {
		debug: (message, context) => writeEntry("debug", message, context),
		info: (message, context) => writeEntry("info", message, context),
		warn: (message, context) => writeEntry("warn", message, context),
		error: (message, context) => writeEntry("error", message, context),
	};
}
