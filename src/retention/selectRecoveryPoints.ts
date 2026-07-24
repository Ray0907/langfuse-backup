export interface RecoveryPointCandidate {
	backup_id: string;
	committed_at: string;
	complete: boolean;
	locked: boolean;
	base_backup_id?: string;
}

export interface RetentionPolicy {
	keep_daily: number;
	keep_weekly: number;
}

export interface RetentionSelection {
	keep_ids: string[];
	delete_ids: string[];
	incomplete_ids: string[];
}

function getDayKey(time_committed: Date): string {
	return time_committed.toISOString().slice(0, 10);
}

function getWeekKey(time_committed: Date): string {
	const time_week = new Date(Date.UTC(
		time_committed.getUTCFullYear(),
		time_committed.getUTCMonth(),
		time_committed.getUTCDate(),
	));
	const offset_monday = (time_week.getUTCDay() + 6) % 7;
	time_week.setUTCDate(time_week.getUTCDate() - offset_monday);
	return getDayKey(time_week);
}

function assertPolicy(policy: RetentionPolicy): void {
	for (const [name_value, count_value] of Object.entries(policy)) {
		if (!Number.isSafeInteger(count_value) || count_value < 0) {
			throw new Error(`${name_value} must be a non-negative integer`);
		}
	}
}

function selectBuckets(
	points_sorted: RecoveryPointCandidate[],
	count_keep: number,
	get_key: (time_committed: Date) => string,
	ids_keep: Set<string>,
): void {
	const keys_seen = new Set<string>();
	for (const point_candidate of points_sorted) {
		const key_bucket = get_key(new Date(point_candidate.committed_at));
		if (keys_seen.has(key_bucket)) {
			continue;
		}
		if (keys_seen.size >= count_keep) {
			break;
		}
		keys_seen.add(key_bucket);
		ids_keep.add(point_candidate.backup_id);
	}
}

export function selectRecoveryPoints(
	points_candidate: RecoveryPointCandidate[],
	policy: RetentionPolicy,
): RetentionSelection {
	assertPolicy(policy);
	const points_complete = points_candidate.filter((point) => point.complete);
	const points_by_id = new Map(points_complete.map((point) => [point.backup_id, point]));
	if (points_by_id.size !== points_complete.length) {
		throw new Error("Recovery-point IDs must be unique");
	}
	for (const point_candidate of points_complete) {
		if (Number.isNaN(Date.parse(point_candidate.committed_at))) {
			throw new Error(`Invalid committed_at for ${point_candidate.backup_id}`);
		}
	}
	const points_sorted = [...points_complete].sort((point_left, point_right) =>
		point_right.committed_at.localeCompare(point_left.committed_at));
	const ids_keep = new Set(
		points_complete
			.filter((point) => point.locked)
			.map((point) => point.backup_id),
	);

	selectBuckets(points_sorted, policy.keep_daily, getDayKey, ids_keep);
	selectBuckets(points_sorted, policy.keep_weekly, getWeekKey, ids_keep);

	const ids_pending = [...ids_keep];
	while (ids_pending.length > 0) {
		const id_backup = ids_pending.pop();
		if (id_backup === undefined) {
			break;
		}
		const id_base = points_by_id.get(id_backup)?.base_backup_id;
		if (id_base === undefined || ids_keep.has(id_base)) {
			continue;
		}
		if (!points_by_id.has(id_base)) {
			throw new Error(`Retained recovery point ${id_backup} has missing base ${id_base}`);
		}
		ids_keep.add(id_base);
		ids_pending.push(id_base);
	}

	return {
		keep_ids: points_sorted
			.filter((point) => ids_keep.has(point.backup_id))
			.map((point) => point.backup_id),
		delete_ids: points_sorted
			.filter((point) => !ids_keep.has(point.backup_id))
			.map((point) => point.backup_id),
		incomplete_ids: points_candidate
			.filter((point) => !point.complete)
			.map((point) => point.backup_id),
	};
}
