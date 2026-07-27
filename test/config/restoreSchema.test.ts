import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { RestoreTargetConfigSchema } from "../../src/config/restoreSchema.js";

const path_example = resolve(
	import.meta.dirname,
	"../../examples/restore-target.example.yaml",
);

describe("RestoreTargetConfigSchema", () => {
	it("accepts the published isolated-target example", async () => {
		const value_config: unknown = parse(await readFile(path_example, "utf8"));

		const config = RestoreTargetConfigSchema.parse(value_config);

		expect(config.deployment_id).toBe("langfuse-recovery-drill");
		expect(config.smoke_test.command).toHaveLength(1);
	});

	it("rejects inline target database credentials", async () => {
		const value_config = parse(await readFile(path_example, "utf8")) as Record<
			string,
			unknown
		>;
		const postgres = value_config.postgres as Record<string, unknown>;
		postgres.url = "postgresql://target:secret@postgres/langfuse";

		expect(() => RestoreTargetConfigSchema.parse(value_config))
			.toThrow(/secret reference/i);
	});

	it("requires an application-level smoke test", async () => {
		const value_config = parse(await readFile(path_example, "utf8")) as Record<
			string,
			unknown
		>;
		delete value_config.smoke_test;

		expect(() => RestoreTargetConfigSchema.parse(value_config))
			.toThrow(/smoke_test/i);
	});
});
