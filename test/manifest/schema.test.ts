import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { readManifest } from "../../src/manifest/readManifest.js";
import { serializeManifest } from "../../src/manifest/serializeManifest.js";

const path_fixture = fileURLToPath(new URL("./fixtures/v1-valid.json", import.meta.url));
const manifest_valid = JSON.parse(readFileSync(path_fixture, "utf8")) as Record<string, unknown>;

describe("manifest schema version 1", () => {
	it("accepts a valid manifest and additive unknown fields", () => {
		const manifest_parsed = readManifest(JSON.stringify({
			...manifest_valid,
			future_field: { value: 1 },
		}));

		expect(manifest_parsed.schema_version).toBe("1.0.0");
		expect(manifest_parsed.future_field).toEqual({ value: 1 });
	});

	it.each(["postgres", "clickhouse", "blob"])(
		"rejects a missing %s receipt",
		(name_component) => {
			const manifest_missing = structuredClone(manifest_valid);
			const components = manifest_missing.components as Record<string, unknown>;
			delete components[name_component];

			expect(() => readManifest(JSON.stringify(manifest_missing))).toThrow(name_component);
		},
	);

	it("rejects unsupported major schema versions", () => {
		expect(() => readManifest(JSON.stringify({
			...manifest_valid,
			schema_version: "2.0.0",
		}))).toThrow(/schema version/i);
	});

	it("rejects secret values anywhere in serialized output", () => {
		expect(() => serializeManifest({
			...manifest_valid,
			debug: {
				password: "not-for-manifests",
			},
		})).toThrow(/secret/i);
	});

	it("produces canonical JSON and a stable SHA-256", () => {
		const serialized_first = serializeManifest(manifest_valid);
		const serialized_second = serializeManifest({
			required_secrets: manifest_valid.required_secrets,
			components: manifest_valid.components,
			consistency: manifest_valid.consistency,
			tool: manifest_valid.tool,
			committed_at: manifest_valid.committed_at,
			created_at: manifest_valid.created_at,
			langfuse_version: manifest_valid.langfuse_version,
			deployment_id: manifest_valid.deployment_id,
			backup_id: manifest_valid.backup_id,
			schema_version: manifest_valid.schema_version,
		});

		expect(serialized_first.json).toBe(serialized_second.json);
		expect(serialized_first.sha256).toMatch(/^[a-f0-9]{64}$/);
		expect(serialized_first.sha256).toBe(serialized_second.sha256);
	});
});
