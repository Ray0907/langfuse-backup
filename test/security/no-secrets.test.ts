import type { S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";

import {
	GcsDestination,
	type GcsBucketLike,
	type GcsFileLike,
} from "../../src/destination/gcsDestination.js";
import { createS3ObjectSource } from "../../src/blob/s3Source.js";
import { createHttpClickhouseQuery } from "../../src/adapters/clickhouse/clickhouseDoctor.js";
import { createLogger } from "../../src/logging/logger.js";
import { redactValue } from "../../src/logging/redact.js";
import { ProcessError, runProcess } from "../../src/process/runProcess.js";
import { serializeManifest } from "../../src/manifest/serializeManifest.js";

const values_secret = {
	password: "db-password-value",
	access_key: "AKIAIOSFODNN7EXAMPLE",
	signature: "signed-query-value",
	token: "header-token-value",
	private_key: "private-key-body",
};

function expectNoSecret(value_output: unknown): void {
	const text_output = value_output instanceof Error
		? `${value_output.name}: ${value_output.message} ${JSON.stringify(value_output)}`
		: typeof value_output === "string"
			? value_output
			: JSON.stringify(value_output);
	for (const value_secret of Object.values(values_secret)) {
		expect(text_output).not.toContain(value_secret);
	}
}

describe("credential boundaries", () => {
	it("redacts structured and unstructured credential forms", () => {
		const value_output = redactValue({
			message: [
				`postgres://user:${values_secret.password}@database/langfuse`,
				`Authorization: Basic ${values_secret.token}`,
				`--password ${values_secret.password}`,
				`?X-Amz-Credential=${values_secret.access_key}`,
				`&X-Amz-Signature=${values_secret.signature}`,
				"-----BEGIN PRIVATE KEY-----",
				values_secret.private_key,
				"-----END PRIVATE KEY-----",
			].join(" "),
		});

		expectNoSecret(value_output);
	});

	it("redacts logger messages and context", () => {
		let text_log = "";
		const logger = createLogger((line_log) => {
			text_log += line_log;
		});

		logger.error(
			`upload failed Authorization: Bearer ${values_secret.token}`,
			{
				signed_url: "https://store.test/object?X-Amz-Signature="
					+ values_secret.signature,
			},
		);

		expectNoSecret(text_log);
	});

	it("redacts ClickHouse provider response failures", async () => {
		const query = createHttpClickhouseQuery({
			endpoint: "https://clickhouse.test",
			password: values_secret.password,
			fetch_impl: async () => new Response(
				`upstream rejected --password ${values_secret.password}`,
				{ status: 500 },
			),
		});

		const error_query = await query("SELECT 1").catch((error: unknown) => error);

		expect(error_query).toBeInstanceOf(Error);
		expectNoSecret(String(error_query));
	});

	it("redacts GCS and S3 provider failures", async () => {
		const file_gcs = {
			save: async () => {
				throw new Error(
					`GCS credential=${values_secret.access_key}`,
				);
			},
		} as unknown as GcsFileLike;
		const bucket_gcs: GcsBucketLike = {
			file: () => file_gcs,
			getFiles: async () => [[]],
		};
		const destination_gcs = new GcsDestination(bucket_gcs);
		const client_s3 = {
			send: async () => {
				throw new Error(
					`S3 X-Amz-Signature=${values_secret.signature}`,
				);
			},
		} as unknown as S3Client;
		const source_s3 = createS3ObjectSource(client_s3, "fixture");

		const errors_provider = await Promise.all([
			destination_gcs.putObject("object", Buffer.from("data"))
				.catch((error: unknown) => error),
			source_s3.listPage({ prefix: "events/" })
				.catch((error: unknown) => error),
		]);

		errors_provider.forEach(expectNoSecret);
	});

	it("redacts native process stderr while preserving failure evidence", async () => {
		const script_failure = [
			`process.stderr.write("--password ${values_secret.password} "`,
			`+ "X-Amz-Signature=${values_secret.signature}");`,
			"process.exit(7);",
		].join("");

		const error_process = await runProcess(
			process.execPath,
			["--eval", script_failure],
		).catch((error: unknown) => error);

		expect(error_process).toBeInstanceOf(ProcessError);
		expect((error_process as ProcessError).exit_code).toBe(7);
		expectNoSecret(error_process);
	});

	it("rejects secret-bearing manifest extensions", () => {
		expect(() => serializeManifest({
			schema_version: "1.0.0",
			debug: { token: values_secret.token },
		})).toThrow(/secret/i);
	});
});
