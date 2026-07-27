import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
	BackupDestination,
	DestinationObject,
} from "../../src/destination/types.js";
import { createPrefixedDestination } from "../../src/runtime/prefixedDestination.js";
import {
	getSecretReferenceName,
	resolveSecret,
} from "../../src/runtime/secret.js";
import { getRestoreRuntimePaths } from "../../src/runtime/restoreRuntime.js";
import { assertBackupId } from "../../src/runtime/backupRuntime.js";

const paths_temporary: string[] = [];

afterEach(async () => {
	await Promise.all(paths_temporary.splice(0).map(async (path_temporary) =>
		rm(path_temporary, { recursive: true, force: true })));
});

function createDestination(paths_seen: string[]): BackupDestination {
	const getObject = (path_object: string): DestinationObject => ({
		path: path_object,
		generation: 1,
		size_bytes: 1,
		sha256: "a".repeat(64),
		updated_at: "2026-07-27T00:00:00.000Z",
		metadata: {},
	});
	return {
		async putObject(path_object) {
			paths_seen.push(path_object);
			return getObject(path_object);
		},
		async getObject(path_object) {
			paths_seen.push(path_object);
			return Buffer.from("x");
		},
		async statObject(path_object) {
			paths_seen.push(path_object);
			return getObject(path_object);
		},
		async deleteObject(path_object) {
			paths_seen.push(path_object);
		},
		async listObjects(prefix_object) {
			paths_seen.push(prefix_object);
			return [getObject(`${prefix_object}item`)];
		},
	};
}

describe("runtime support", () => {
	it("resolves environment and mounted-file secrets without changing their names",
		async () => {
			const path_temporary = await mkdtemp(join(tmpdir(), "langfuse-secret-"));
			paths_temporary.push(path_temporary);
			const path_secret = join(path_temporary, "postgres-url");
			await writeFile(path_secret, "postgres://file-secret\n", { mode: 0o600 });

			expect(await resolveSecret(
				{ env: "LANGFUSE_TEST_SECRET" },
				{ LANGFUSE_TEST_SECRET: "environment-secret" },
			)).toBe("environment-secret");
			expect(await resolveSecret({ file: path_secret })).toBe("postgres://file-secret");
			expect(getSecretReferenceName({ env: "LANGFUSE_TEST_SECRET" }))
				.toBe("env:LANGFUSE_TEST_SECRET");
			expect(getSecretReferenceName({ file: path_secret }))
				.toBe(`file:${path_secret}`);
		});

	it("fails closed when a referenced environment secret is absent", async () => {
		await expect(resolveSecret({ env: "MISSING_SECRET" }, {}))
			.rejects.toThrow(/MISSING_SECRET.*not set/i);
	});

	it("maps logical object paths through a normalized destination prefix", async () => {
		const paths_seen: string[] = [];
		const destination = createPrefixedDestination(
			createDestination(paths_seen),
			"/recovery-points/",
		);

		await destination.putObject("deployments/prod/manifest.json", Buffer.from("x"));
		const objects_found = await destination.listObjects("deployments/prod/");

		expect(paths_seen).toEqual([
			"recovery-points/deployments/prod/manifest.json",
			"recovery-points/deployments/prod/",
		]);
		expect(objects_found[0]?.path).toBe("deployments/prod/item");
	});

	it("uses one target-global lock and journal across backup IDs", () => {
		const paths_first = getRestoreRuntimePaths("target-prod", "backup-1");
		const paths_second = getRestoreRuntimePaths("target-prod", "backup-2");

		expect(paths_first.lock).toBe(paths_second.lock);
		expect(paths_first.journal).toBe(paths_second.journal);
		expect(paths_first.report).not.toBe(paths_second.report);
	});

	it("rejects backup IDs that could escape their object prefix", () => {
		expect(() => assertBackupId("backup-20260727")).not.toThrow();
		expect(() => assertBackupId("../another-prefix")).toThrow(/backup ID/i);
		expect(() => assertBackupId("backup/child")).toThrow(/backup ID/i);
	});
});
