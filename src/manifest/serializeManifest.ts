import { createHash } from "node:crypto";

import { parseManifest } from "./readManifest.js";
import type { RecoveryManifest } from "./schema.js";

const pattern_secret_key =
	/(^|_)(access_key|authorization|credential|hmac_secret|password|private_key|token)($|_)/i;
const pattern_secret_value =
	/([a-z][\w+.-]*:\/\/)[^:\s/@]+:[^@\s/]+@|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+\S+/i;

function assertNoSecrets(value_input: unknown, path_value = "manifest"): void {
	if (typeof value_input === "string") {
		if (pattern_secret_value.test(value_input)) {
			throw new Error(`Secret value is not allowed at ${path_value}`);
		}
		return;
	}

	if (Array.isArray(value_input)) {
		value_input.forEach((item_value, index_value) => {
			assertNoSecrets(item_value, `${path_value}[${index_value}]`);
		});
		return;
	}

	if (value_input === null || typeof value_input !== "object") {
		return;
	}

	for (const [key_value, item_value] of Object.entries(value_input)) {
		if (pattern_secret_key.test(key_value)) {
			throw new Error(`Secret-bearing field is not allowed at ${path_value}.${key_value}`);
		}
		assertNoSecrets(item_value, `${path_value}.${key_value}`);
	}
}

function canonicalize(value_input: unknown): unknown {
	if (Array.isArray(value_input)) {
		return value_input.map((item_value) => canonicalize(item_value));
	}

	if (value_input !== null && typeof value_input === "object") {
		return Object.fromEntries(
			Object.keys(value_input)
				.sort()
				.map((key_value) => [
					key_value,
					canonicalize(Reflect.get(value_input, key_value)),
				]),
		);
	}

	return value_input;
}

export interface SerializedManifest {
	json: string;
	sha256: string;
	manifest: RecoveryManifest;
}

export function serializeManifest(value_manifest: unknown): SerializedManifest {
	assertNoSecrets(value_manifest);
	const manifest = parseManifest(value_manifest);
	const json = `${JSON.stringify(canonicalize(manifest), null, 2)}\n`;
	const sha256 = createHash("sha256").update(json).digest("hex");

	return { json, sha256, manifest };
}
