import { describe, expect, it } from "vitest";

import type { DestinationObject } from "../../src/destination/types.js";
import type { RecoveryManifest } from "../../src/manifest/schema.js";
import {
	createRestorePlan,
	type RestorePlanOptions,
} from "../../src/restore/restorePlan.js";

const timestamp = "2026-07-24T12:00:00.000Z";

function createObject(
	path_object: string,
	size_bytes: number,
	sha256: string,
): DestinationObject {
	return {
		path: path_object,
		generation: 1,
		size_bytes,
		sha256,
		updated_at: timestamp,
		metadata: {},
	};
}

function createManifest(mode: "coordinated" | "online" = "coordinated"):
	RecoveryManifest {
	return {
		schema_version: "1.0.0",
		backup_id: "backup-1",
		deployment_id: "source",
		created_at: timestamp,
		committed_at: timestamp,
		tool: {
			version: "0.1.0",
			source_revision: "abc123",
		},
		consistency: {
			mode,
			boundary_at: timestamp,
			...(mode === "coordinated" ? { queue_drained_at: timestamp } : {}),
		},
		components: {
			postgres: {
				provider: "postgres",
				object_path: "backups/postgres.dump",
				size_bytes: 100,
				sha256: "a".repeat(64),
				started_at: timestamp,
				completed_at: timestamp,
				verified_at: timestamp,
				client_version: "17.5",
				server_version: "17.5",
			},
			clickhouse: {
				provider: "clickhouse",
				operation_id: "backup-operation",
				database: "default",
				object_prefix: "backups/clickhouse",
				status: "BACKUP_CREATED",
				size_bytes: 200,
				started_at: timestamp,
				completed_at: timestamp,
				verified_at: timestamp,
				server_version: "25.7.1",
			},
			blob: {
				provider: "s3_copy",
				inventory_path: "backups/blob.ndjson.gz",
				object_count: 2,
				size_bytes: 300,
				sha256: "b".repeat(64),
				started_at: timestamp,
				completed_at: timestamp,
				verified_at: timestamp,
			},
		},
		required_secrets: ["POSTGRES_URL", "CLICKHOUSE_HMAC"],
	};
}

function createOptions(): RestorePlanOptions {
	const manifest = createManifest();
	return {
		manifest,
		source_langfuse_version: "3.100.0",
		target: {
			deployment_id: "target",
			langfuse_version: "3.101.0",
			postgres_version: "17.6",
			clickhouse_version: "25.7.4",
			postgres_empty: true,
			clickhouse_empty: true,
			blob_empty: true,
			secret_references: ["POSTGRES_URL", "CLICKHOUSE_HMAC"],
		},
		artifacts: {
			postgres: createObject(
				manifest.components.postgres.object_path,
				manifest.components.postgres.size_bytes,
				manifest.components.postgres.sha256,
			),
			blob: createObject(
				manifest.components.blob.inventory_path,
				manifest.components.blob.size_bytes,
				manifest.components.blob.sha256,
			),
			clickhouse_valid: true,
		},
	};
}

describe("createRestorePlan", () => {
	it("produces a read-only ordered plan with all destructive operations", () => {
		const options = createOptions();
		const plan_restore = createRestorePlan(options);

		expect(plan_restore.estimated_artifact_size_bytes).toBe(600);
		expect(plan_restore.requires_downtime).toBe(true);
		expect(plan_restore.actions.map((action) => action.component)).toEqual([
			"target_lock",
			"blob",
			"postgres",
			"clickhouse",
			"health_checks",
			"smoke_tests",
			"report",
			"target_unlock",
		]);
		expect(plan_restore.actions.filter((action) => action.destructive)
			.map((action) => action.component)).toEqual([
			"blob",
			"postgres",
			"clickhouse",
		]);
		expect(plan_restore.required_secrets).toEqual([
			"CLICKHOUSE_HMAC",
			"POSTGRES_URL",
		]);
	});

	it("rejects restoring into the source deployment", () => {
		const options = createOptions();
		options.target.deployment_id = "source";

		expect(() => createRestorePlan(options)).toThrow(/source.*target.*differ/i);
	});

	it.each([
		"postgres_empty",
		"clickhouse_empty",
		"blob_empty",
	] as const)("rejects a non-empty target for %s", (field_empty) => {
		const options = createOptions();
		options.target[field_empty] = false;

		expect(() => createRestorePlan(options)).toThrow(/target.*not empty/i);
	});

	it.each([
		["langfuse_version", "4.0.0", /Langfuse.*incompatible/i],
		["postgres_version", "16.9", /PostgreSQL.*incompatible/i],
		["clickhouse_version", "25.8.0", /ClickHouse.*incompatible/i],
	] as const)("rejects unsupported %s", (field_version, version, pattern_error) => {
		const options = createOptions();
		options.target[field_version] = version;

		expect(() => createRestorePlan(options)).toThrow(pattern_error);
	});

	it("rejects missing required secret references", () => {
		const options = createOptions();
		options.target.secret_references = ["POSTGRES_URL"];

		expect(() => createRestorePlan(options)).toThrow(/missing.*CLICKHOUSE_HMAC/i);
	});

	it("rejects missing or mismatched component artifacts", () => {
		const missing = createOptions();
		missing.artifacts.postgres = null;
		expect(() => createRestorePlan(missing)).toThrow(/PostgreSQL.*missing/i);

		const mismatched = createOptions();
		mismatched.artifacts.blob = createObject(
			mismatched.manifest.components.blob.inventory_path,
			1,
			"c".repeat(64),
		);
		expect(() => createRestorePlan(mismatched)).toThrow(/blob.*mismatch/i);

		const clickhouse_invalid = createOptions();
		clickhouse_invalid.artifacts.clickhouse_valid = false;
		expect(() => createRestorePlan(clickhouse_invalid))
			.toThrow(/ClickHouse.*missing.*mismatch/i);
	});

	it("requires explicit acceptance for online consistency", () => {
		const options = createOptions();
		options.manifest = createManifest("online");

		expect(() => createRestorePlan(options)).toThrow(/accept-online-consistency/i);
		expect(createRestorePlan({
			...options,
			accept_online_consistency: true,
		}).backup_id).toBe("backup-1");
	});
});
