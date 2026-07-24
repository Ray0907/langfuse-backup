import { describe, expect, it } from "vitest";

import type { QueueSnapshot } from "../../src/adapters/redis/queueInspector.js";
import { executeWithConsistencyGate } from "../../src/orchestration/consistencyGate.js";
import { waitForQueueDrain } from "../../src/orchestration/waitForQueueDrain.js";

function createSnapshot(
	pending_count: number,
	failed_count = 0,
	captured_at = "2026-07-24T12:00:00.000Z",
): QueueSnapshot {
	return {
		captured_at,
		pending_count,
		failed_count,
		queues: [{
			name: "ingestion-queue",
			waiting: pending_count,
			active: 0,
			prioritized: 0,
			delayed: 0,
			waiting_children: 0,
			failed: failed_count,
		}],
	};
}

describe("waitForQueueDrain", () => {
	it("requires two consecutive empty snapshots", async () => {
		const snapshots = [
			createSnapshot(1),
			createSnapshot(0, 0, "2026-07-24T12:00:01.000Z"),
			createSnapshot(1),
			createSnapshot(0, 0, "2026-07-24T12:00:03.000Z"),
			createSnapshot(0, 0, "2026-07-24T12:00:04.000Z"),
		];
		let index_snapshot = 0;

		const snapshot_drained = await waitForQueueDrain({
			inspect: async () => snapshots[index_snapshot++] ?? createSnapshot(0),
			timeout_ms: 10_000,
			poll_interval_ms: 1,
			sleep: async () => undefined,
			get_time_ms: () => index_snapshot,
		});

		expect(index_snapshot).toBe(5);
		expect(snapshot_drained.captured_at).toBe("2026-07-24T12:00:04.000Z");
	});

	it("reports failed and delayed jobs instead of accepting them as drained", async () => {
		const snapshot_blocked: QueueSnapshot = {
			...createSnapshot(1, 2),
			queues: [{
				name: "ingestion-queue",
				waiting: 0,
				active: 0,
				prioritized: 0,
				delayed: 1,
				waiting_children: 0,
				failed: 2,
			}],
		};
		let time_current = 0;

		await expect(waitForQueueDrain({
			inspect: async () => snapshot_blocked,
			timeout_ms: 2,
			poll_interval_ms: 1,
			sleep: async () => {
				time_current += 1;
			},
			get_time_ms: () => time_current,
		})).rejects.toMatchObject({
			snapshot: snapshot_blocked,
			message: expect.stringMatching(/delayed.*failed/i) as string,
		});
	});
});

describe("executeWithConsistencyGate", () => {
	it("runs the post-hook and prevents components after a drain timeout", async () => {
		const events: string[] = [];
		let time_current = 0;

		await expect(executeWithConsistencyGate({
			run_pre_hook: async () => {
				events.push("pre");
			},
			run_post_hook: async () => {
				events.push("post");
			},
			inspect: async () => createSnapshot(1),
			timeout_ms: 1,
			poll_interval_ms: 1,
			sleep: async () => {
				time_current += 1;
			},
			get_time_ms: () => time_current,
		}, async () => {
			events.push("components");
		})).rejects.toThrow(/queue drain timed out/i);

		expect(events).toEqual(["pre", "post"]);
	});
});
