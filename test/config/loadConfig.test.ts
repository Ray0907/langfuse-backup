import { describe, expect, it } from "vitest";

import { parseConfigText } from "../../src/config/loadConfig.js";

const config_valid = `
deployment_id: source-prod
consistency:
  mode: coordinated
destination:
  provider: gcs
  bucket: langfuse-backups
postgres:
  url:
    env: POSTGRES_URL
clickhouse:
  endpoint: http://clickhouse:8123
  database: default
  named_collection: langfuse_backup
redis:
  url:
    file: /run/secrets/redis_url
blob:
  provider: gcs
  bucket: langfuse-events
`;

describe("parseConfigText", () => {
	it("returns a deeply frozen typed configuration", () => {
		const config = parseConfigText(config_valid);

		expect(config.deployment_id).toBe("source-prod");
		expect(config.consistency.mode).toBe("coordinated");
		expect(Object.isFrozen(config)).toBe(true);
		expect(Object.isFrozen(config.destination)).toBe(true);
	});

	it("rejects a missing deployment ID", () => {
		expect(() => parseConfigText(config_valid.replace("deployment_id: source-prod\n", "")))
			.toThrow(/deployment_id/);
	});

	it("rejects unsupported consistency modes", () => {
		expect(() => parseConfigText(config_valid.replace("coordinated", "snapshot")))
			.toThrow(/consistency/);
	});

	it("rejects inline secret values", () => {
		const config_inline = config_valid.replace(
			"url:\n    env: POSTGRES_URL",
			"url: postgres://admin:password@postgres/langfuse",
		);

		expect(() => parseConfigText(config_inline)).toThrow(/secret reference/i);
	});
});
