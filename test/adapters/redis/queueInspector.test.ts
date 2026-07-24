import { describe, expect, it } from "vitest";

import {
	inspectQueues,
	type QueueCountsReader,
} from "../../../src/adapters/redis/queueInspector.js";

describe("inspectQueues", () => {
	it("returns every drain-relevant BullMQ state without mutating queues", async () => {
		const calls_states: string[][] = [];
		const queue_reader: QueueCountsReader = {
			async getJobCounts(...states_queue) {
				calls_states.push(states_queue);
				return {
					waiting: 2,
					active: 1,
					prioritized: 3,
					delayed: 4,
					"waiting-children": 5,
					failed: 6,
				};
			},
		};

		const snapshot = await inspectQueues(
			["ingestion-queue"],
			() => queue_reader,
			() => new Date("2026-07-24T12:00:00.000Z"),
		);

		expect(calls_states).toEqual([[
			"waiting",
			"active",
			"prioritized",
			"delayed",
			"waiting-children",
			"failed",
		]]);
		expect(snapshot.queues[0]).toMatchObject({
			name: "ingestion-queue",
			waiting: 2,
			active: 1,
			prioritized: 3,
			delayed: 4,
			waiting_children: 5,
			failed: 6,
		});
		expect(snapshot.pending_count).toBe(15);
		expect(snapshot.failed_count).toBe(6);
		expect(snapshot.captured_at).toBe("2026-07-24T12:00:00.000Z");
	});

	it("sums counts across all configured queues", async () => {
		const snapshot = await inspectQueues(
			["ingestion-queue", "otel-ingestion-queue"],
			(name_queue) => ({
				async getJobCounts() {
					return {
						waiting: name_queue === "ingestion-queue" ? 1 : 2,
						active: 0,
						prioritized: 0,
						delayed: 0,
						"waiting-children": 0,
						failed: 0,
					};
				},
			}),
		);

		expect(snapshot.pending_count).toBe(3);
		expect(snapshot.queues).toHaveLength(2);
	});
});
