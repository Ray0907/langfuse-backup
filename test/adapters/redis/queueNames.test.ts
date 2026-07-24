import { describe, expect, it } from "vitest";

import { getIngestionQueueNames } from "../../../src/adapters/redis/queueNames.js";

describe("getIngestionQueueNames", () => {
	it("returns every base ingestion queue for one shard", () => {
		expect(getIngestionQueueNames({
			ingestion: 1,
			secondary_ingestion: 1,
			otel_ingestion: 1,
			secondary_otel_ingestion: 1,
		})).toEqual([
			"ingestion-queue",
			"secondary-ingestion-queue",
			"otel-ingestion-queue",
			"secondary-otel-ingestion-queue",
		]);
	});

	it("uses the upstream numeric suffix for configured shards", () => {
		expect(getIngestionQueueNames({
			ingestion: 3,
			secondary_ingestion: 1,
			otel_ingestion: 2,
			secondary_otel_ingestion: 1,
		})).toEqual([
			"ingestion-queue",
			"ingestion-queue-1",
			"ingestion-queue-2",
			"secondary-ingestion-queue",
			"otel-ingestion-queue",
			"otel-ingestion-queue-1",
			"secondary-otel-ingestion-queue",
		]);
	});

	it("rejects invalid shard counts", () => {
		expect(() => getIngestionQueueNames({
			ingestion: 0,
			secondary_ingestion: 1,
			otel_ingestion: 1,
			secondary_otel_ingestion: 1,
		})).toThrow(/shard count/i);
	});
});
