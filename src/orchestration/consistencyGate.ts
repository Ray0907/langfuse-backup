import type { QueueSnapshot } from "../adapters/redis/queueInspector.js";
import {
	waitForQueueDrain,
	type WaitForQueueDrainOptions,
} from "./waitForQueueDrain.js";

export interface ConsistencyGateOptions extends WaitForQueueDrainOptions {
	run_pre_hook: () => Promise<void>;
	run_post_hook: () => Promise<void>;
}

export interface ConsistencyBoundary {
	queue_drained_at: string;
	snapshot: QueueSnapshot;
}

export async function executeWithConsistencyGate<T>(
	options: ConsistencyGateOptions,
	run_components: (boundary: ConsistencyBoundary) => Promise<T>,
): Promise<T> {
	try {
		await options.run_pre_hook();
		const snapshot = await waitForQueueDrain(options);
		return await run_components({
			queue_drained_at: snapshot.captured_at,
			snapshot,
		});
	} finally {
		await options.run_post_hook();
	}
}
