import type { QueueSnapshot } from "../adapters/redis/queueInspector.js";

export interface WaitForQueueDrainOptions {
	inspect: () => Promise<QueueSnapshot>;
	timeout_ms: number;
	poll_interval_ms?: number;
	sleep?: (duration_ms: number) => Promise<void>;
	get_time_ms?: () => number;
}

export class QueueDrainTimeoutError extends Error {
	public readonly snapshot: QueueSnapshot;

	public constructor(snapshot: QueueSnapshot) {
		const count_delayed = snapshot.queues.reduce(
			(count_total, queue_snapshot) => count_total + queue_snapshot.delayed,
			0,
		);
		super(
			`Queue drain timed out: ${count_delayed} delayed, `
			+ `${snapshot.failed_count} failed, ${snapshot.pending_count} pending`,
		);
		this.name = "QueueDrainTimeoutError";
		this.snapshot = snapshot;
	}
}

function sleepDefault(duration_ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, duration_ms));
}

export async function waitForQueueDrain(
	options: WaitForQueueDrainOptions,
): Promise<QueueSnapshot> {
	const get_time_ms = options.get_time_ms ?? Date.now;
	const sleep = options.sleep ?? sleepDefault;
	const poll_interval_ms = options.poll_interval_ms ?? 1_000;
	const time_started = get_time_ms();
	let count_empty = 0;

	while (true) {
		const snapshot_queue = await options.inspect();
		const is_empty = snapshot_queue.pending_count === 0
			&& snapshot_queue.failed_count === 0;
		count_empty = is_empty ? count_empty + 1 : 0;
		if (count_empty >= 2) {
			return snapshot_queue;
		}
		if (get_time_ms() - time_started >= options.timeout_ms) {
			throw new QueueDrainTimeoutError(snapshot_queue);
		}
		await sleep(poll_interval_ms);
	}
}
