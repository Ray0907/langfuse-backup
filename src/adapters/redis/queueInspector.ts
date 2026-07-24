import {
	Queue,
	type ConnectionOptions,
	type JobType,
} from "bullmq";

const states_drain = [
	"waiting",
	"active",
	"prioritized",
	"delayed",
	"waiting-children",
	"failed",
] as const;

type QueueState = typeof states_drain[number];

export interface QueueCountsReader {
	getJobCounts: (...states_queue: JobType[]) => Promise<Record<string, number>>;
}

export interface QueueStateSnapshot {
	name: string;
	waiting: number;
	active: number;
	prioritized: number;
	delayed: number;
	waiting_children: number;
	failed: number;
}

export interface QueueSnapshot {
	captured_at: string;
	queues: QueueStateSnapshot[];
	pending_count: number;
	failed_count: number;
}

function getCount(
	counts_queue: Record<string, number>,
	state_queue: QueueState,
): number {
	const count_state = counts_queue[state_queue] ?? 0;
	if (!Number.isSafeInteger(count_state) || count_state < 0) {
		throw new Error(`Invalid BullMQ ${state_queue} count`);
	}
	return count_state;
}

export async function inspectQueues(
	names_queue: string[],
	get_queue: (name_queue: string) => QueueCountsReader,
	get_now: () => Date = () => new Date(),
): Promise<QueueSnapshot> {
	const queues_snapshot = await Promise.all(names_queue.map(async (name_queue) => {
		const counts_queue = await get_queue(name_queue).getJobCounts(...states_drain);
		return {
			name: name_queue,
			waiting: getCount(counts_queue, "waiting"),
			active: getCount(counts_queue, "active"),
			prioritized: getCount(counts_queue, "prioritized"),
			delayed: getCount(counts_queue, "delayed"),
			waiting_children: getCount(counts_queue, "waiting-children"),
			failed: getCount(counts_queue, "failed"),
		};
	}));
	const pending_count = queues_snapshot.reduce(
		(total_pending, queue_snapshot) =>
			total_pending
			+ queue_snapshot.waiting
			+ queue_snapshot.active
			+ queue_snapshot.prioritized
			+ queue_snapshot.delayed
			+ queue_snapshot.waiting_children,
		0,
	);
	const failed_count = queues_snapshot.reduce(
		(total_failed, queue_snapshot) => total_failed + queue_snapshot.failed,
		0,
	);

	return {
		captured_at: get_now().toISOString(),
		queues: queues_snapshot,
		pending_count,
		failed_count,
	};
}

function getRedisConnection(redis_url: string): ConnectionOptions {
	const url_redis = new URL(redis_url);
	if (!["redis:", "rediss:"].includes(url_redis.protocol)) {
		throw new Error("Redis URL must use redis:// or rediss://");
	}
	const database_path = url_redis.pathname.replace(/^\//, "");
	const database = database_path === "" ? 0 : Number(database_path);
	if (!Number.isSafeInteger(database) || database < 0) {
		throw new Error("Redis URL contains an invalid database");
	}

	return {
		host: url_redis.hostname,
		port: Number(url_redis.port || 6379),
		db: database,
		...(url_redis.username === ""
			? {}
			: { username: decodeURIComponent(url_redis.username) }),
		...(url_redis.password === ""
			? {}
			: { password: decodeURIComponent(url_redis.password) }),
		...(url_redis.protocol === "rediss:" ? { tls: {} } : {}),
	};
}

export async function inspectRedisQueues(
	redis_url: string,
	names_queue: string[],
	get_now: () => Date = () => new Date(),
): Promise<QueueSnapshot> {
	const connection = getRedisConnection(redis_url);
	const queues = new Map<string, Queue>();

	try {
		return await inspectQueues(
			names_queue,
			(name_queue) => {
				const queue_existing = queues.get(name_queue);
				if (queue_existing !== undefined) {
					return queue_existing;
				}
				const queue_created = new Queue(name_queue, { connection });
				queues.set(name_queue, queue_created);
				return queue_created;
			},
			get_now,
		);
	} finally {
		await Promise.all([...queues.values()].map(async (queue) => queue.close()));
	}
}
