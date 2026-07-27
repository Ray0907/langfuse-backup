import { readFile } from "node:fs/promises";

import type { SecretReference } from "../config/schema.js";

export async function resolveSecret(
	reference_secret: SecretReference,
	environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
	if ("env" in reference_secret) {
		const value_secret = environment[reference_secret.env];
		if (value_secret === undefined || value_secret === "") {
			throw new Error(`Referenced environment variable ${reference_secret.env} is not set`);
		}
		return value_secret;
	}

	const value_secret = (await readFile(reference_secret.file, "utf8")).trimEnd();
	if (value_secret === "") {
		throw new Error(`Referenced secret file ${reference_secret.file} is empty`);
	}
	return value_secret;
}

export function getSecretReferenceName(reference_secret: SecretReference): string {
	return "env" in reference_secret
		? `env:${reference_secret.env}`
		: `file:${reference_secret.file}`;
}
