import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
	inspectRecoveryPoint,
} from "../../src/commands/inspect.js";
import { listRecoveryPoints } from "../../src/commands/list.js";
import { verifyRecoveryPoint } from "../../src/commands/verify.js";
import type {
	BackupDestination,
	DestinationObject,
} from "../../src/destination/types.js";

function createDestination(
	objects_input: Map<string, Buffer>,
): BackupDestination {
	function getMetadata(path_object: string, data_object: Buffer): DestinationObject {
		return {
			path: path_object,
			generation: 1,
			size_bytes: data_object.byteLength,
			sha256: createHash("sha256").update(data_object).digest("hex"),
			updated_at: "2026-07-24T12:00:00.000Z",
			metadata: {},
		};
	}

	return {
		async putObject(path_object, data_object) {
			objects_input.set(path_object, Buffer.from(data_object));
			return getMetadata(path_object, data_object);
		},
		async getObject(path_object) {
			const data_object = objects_input.get(path_object);
			if (data_object === undefined) {
				throw Object.assign(new Error("missing"), { code: 404 });
			}
			return data_object;
		},
		async statObject(path_object) {
			const data_object = objects_input.get(path_object);
			return data_object === undefined ? null : getMetadata(path_object, data_object);
		},
		async deleteObject(path_object) {
			objects_input.delete(path_object);
		},
		async listObjects(prefix_object) {
			return [...objects_input.entries()]
				.filter(([path_object]) => path_object.startsWith(prefix_object))
				.map(([path_object, data_object]) =>
					getMetadata(path_object, data_object));
		},
	};
}

function getFixtureManifest(): Record<string, unknown> {
	const path_fixture = fileURLToPath(
		new URL("../manifest/fixtures/v1-valid.json", import.meta.url),
	);
	const manifest_fixture = JSON.parse(
		readFileSync(path_fixture, "utf8"),
	) as Record<string, unknown>;
	manifest_fixture.deployment_id = "prod";
	manifest_fixture.backup_id = "backup-001";
	return manifest_fixture;
}

describe("recovery-point commands", () => {
	it("lists only prefixes containing valid manifests", async () => {
		const objects = new Map<string, Buffer>([
			[
				"deployments/prod/backups/backup-001/manifest.json",
				Buffer.from(JSON.stringify(getFixtureManifest())),
			],
			[
				"deployments/prod/backups/incomplete/manifest.json",
				Buffer.from("{broken"),
			],
			[
				"deployments/prod/backups/staging/postgres.dump",
				Buffer.from("dump"),
			],
		]);

		const recovery_points = await listRecoveryPoints(
			createDestination(objects),
			"prod",
		);

		expect(recovery_points).toHaveLength(1);
		expect(recovery_points[0]?.manifest.backup_id).toBe("backup-001");
	});

	it("inspects a committed manifest by backup ID", async () => {
		const manifest_fixture = getFixtureManifest();
		const objects = new Map<string, Buffer>([[
			"deployments/prod/backups/backup-001/manifest.json",
			Buffer.from(JSON.stringify(manifest_fixture)),
		]]);

		const recovery_point = await inspectRecoveryPoint(
			createDestination(objects),
			"prod",
			"backup-001",
		);

		expect(recovery_point.manifest.deployment_id).toBe("prod");
	});

	it("rejects artifact metadata that does not match the manifest", async () => {
		const manifest_fixture = getFixtureManifest();
		const components = manifest_fixture.components as Record<string, unknown>;
		const postgres = components.postgres as Record<string, unknown>;
		const blob = components.blob as Record<string, unknown>;
		const objects = new Map<string, Buffer>([
			[
				"deployments/prod/backups/backup-001/manifest.json",
				Buffer.from(JSON.stringify(manifest_fixture)),
			],
			[String(postgres.object_path), Buffer.from("wrong postgres artifact")],
			[String(blob.inventory_path), Buffer.from("wrong blob inventory")],
		]);

		await expect(verifyRecoveryPoint(
			createDestination(objects),
			"prod",
			"backup-001",
		)).rejects.toThrow(/PostgreSQL.*mismatch/i);
	});
});
