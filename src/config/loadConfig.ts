import { readFile } from "node:fs/promises";

import { parse } from "yaml";

import { ConfigSchema, type BackupConfig } from "./schema.js";

function freezeDeep<T>(value_input: T): Readonly<T> {
	if (value_input === null || typeof value_input !== "object") {
		return value_input;
	}

	for (const value_child of Object.values(value_input)) {
		freezeDeep(value_child);
	}

	return Object.isFrozen(value_input) ? value_input : Object.freeze(value_input);
}

export function parseConfigText(text_config: string): BackupConfig {
	const value_config: unknown = parse(text_config);
	const result_config = ConfigSchema.safeParse(value_config);

	if (!result_config.success) {
		const details_error = result_config.error.issues
			.map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
			.join("; ");
		throw new Error(`Invalid configuration: ${details_error}`);
	}

	return freezeDeep(result_config.data) as BackupConfig;
}

export async function loadConfig(path_config: string): Promise<BackupConfig> {
	const text_config = await readFile(path_config, "utf8");
	return parseConfigText(text_config);
}
