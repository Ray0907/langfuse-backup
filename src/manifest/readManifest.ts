import { ManifestSchema, type RecoveryManifest } from "./schema.js";

function assertSchemaVersion(value_manifest: unknown): void {
	if (value_manifest === null || typeof value_manifest !== "object") {
		throw new Error("Manifest must be an object");
	}

	const version_schema = Reflect.get(value_manifest, "schema_version");
	if (typeof version_schema !== "string" || version_schema.split(".")[0] !== "1") {
		throw new Error(`Unsupported manifest schema version: ${String(version_schema)}`);
	}
}

export function parseManifest(value_manifest: unknown): RecoveryManifest {
	assertSchemaVersion(value_manifest);
	const result_manifest = ManifestSchema.safeParse(value_manifest);

	if (!result_manifest.success) {
		const details_error = result_manifest.error.issues
			.map((issue) => `${issue.path.join(".")}: ${issue.message}`)
			.join("; ");
		throw new Error(`Invalid manifest: ${details_error}`);
	}

	return result_manifest.data;
}

export function readManifest(text_manifest: string): RecoveryManifest {
	let value_manifest: unknown;

	try {
		value_manifest = JSON.parse(text_manifest);
	} catch (error) {
		throw new Error("Manifest is not valid JSON", { cause: error });
	}

	return parseManifest(value_manifest);
}
