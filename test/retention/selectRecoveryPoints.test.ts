import { describe, expect, it, vi } from "vitest";

import { runPrune } from "../../src/commands/prune.js";
import {
	selectRecoveryPoints,
	type RecoveryPointCandidate,
} from "../../src/retention/selectRecoveryPoints.js";

function createPoint(
	backup_id: string,
	committed_at: string,
	options: Partial<RecoveryPointCandidate> = {},
): RecoveryPointCandidate {
	return {
		backup_id,
		committed_at,
		complete: true,
		locked: false,
		...options,
	};
}

describe("selectRecoveryPoints", () => {
	it("keeps configured UTC daily and weekly recovery points", () => {
		const points = [
			createPoint("day-1-new", "2026-07-24T20:00:00.000Z"),
			createPoint("day-1-old", "2026-07-24T10:00:00.000Z"),
			createPoint("day-2", "2026-07-23T10:00:00.000Z"),
			createPoint("week-previous", "2026-07-17T10:00:00.000Z"),
			createPoint("old", "2026-06-01T10:00:00.000Z"),
		];

		const selection = selectRecoveryPoints(points, {
			keep_daily: 2,
			keep_weekly: 2,
		});

		expect(selection.keep_ids).toEqual(expect.arrayContaining([
			"day-1-new",
			"day-2",
			"week-previous",
		]));
		expect(selection.delete_ids).toContain("day-1-old");
		expect(selection.delete_ids).toContain("old");
	});

	it("keeps locked points and bases required by retained incrementals", () => {
		const points = [
			createPoint("incremental-new", "2026-07-24T10:00:00.000Z", {
				base_backup_id: "base-old",
			}),
			createPoint("base-old", "2026-06-01T10:00:00.000Z"),
			createPoint("locked-old", "2026-05-01T10:00:00.000Z", { locked: true }),
		];

		const selection = selectRecoveryPoints(points, {
			keep_daily: 1,
			keep_weekly: 0,
		});

		expect(selection.keep_ids).toEqual(expect.arrayContaining([
			"incremental-new",
			"base-old",
			"locked-old",
		]));
		expect(selection.delete_ids).toEqual([]);
	});

	it("separates incomplete staging prefixes from committed recovery points", () => {
		const points = [
			createPoint("complete", "2026-07-24T10:00:00.000Z"),
			createPoint("staging-only", "2026-07-23T10:00:00.000Z", {
				complete: false,
			}),
		];

		const selection = selectRecoveryPoints(points, {
			keep_daily: 1,
			keep_weekly: 0,
		});

		expect(selection.incomplete_ids).toEqual(["staging-only"]);
		expect(selection.delete_ids).not.toContain("staging-only");
	});

	it("uses UTC boundaries rather than the host timezone", () => {
		const points = [
			createPoint("before-midnight", "2026-07-23T23:59:59.999Z"),
			createPoint("after-midnight", "2026-07-24T00:00:00.000Z"),
		];

		const selection = selectRecoveryPoints(points, {
			keep_daily: 2,
			keep_weekly: 0,
		});

		expect(selection.keep_ids).toEqual(expect.arrayContaining([
			"before-midnight",
			"after-midnight",
		]));
	});
});

describe("runPrune", () => {
	it("defaults to dry-run and deletes only after explicit confirmation", async () => {
		const points = [
			createPoint("keep", "2026-07-24T10:00:00.000Z"),
			createPoint("delete", "2026-07-23T10:00:00.000Z"),
		];
		const delete_recovery_point = vi.fn(async () => undefined);

		const plan_dry = await runPrune({
			points,
			policy: { keep_daily: 1, keep_weekly: 0 },
			delete_recovery_point,
		});
		expect(plan_dry.dry_run).toBe(true);
		expect(plan_dry.delete_ids).toEqual(["delete"]);
		expect(delete_recovery_point).not.toHaveBeenCalled();

		const plan_confirmed = await runPrune({
			points,
			policy: { keep_daily: 1, keep_weekly: 0 },
			confirm: true,
			delete_recovery_point,
		});
		expect(plan_confirmed.dry_run).toBe(false);
		expect(delete_recovery_point).toHaveBeenCalledWith("delete");
	});
});
