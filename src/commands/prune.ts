import {
	selectRecoveryPoints,
	type RecoveryPointCandidate,
	type RetentionPolicy,
	type RetentionSelection,
} from "../retention/selectRecoveryPoints.js";

export interface RunPruneOptions {
	points: RecoveryPointCandidate[];
	policy: RetentionPolicy;
	confirm?: boolean;
	delete_recovery_point: (backup_id: string) => Promise<void>;
}

export interface PruneResult extends RetentionSelection {
	dry_run: boolean;
}

export async function runPrune(options: RunPruneOptions): Promise<PruneResult> {
	const selection = selectRecoveryPoints(options.points, options.policy);
	const dry_run = options.confirm !== true;
	if (!dry_run) {
		for (const backup_id of selection.delete_ids) {
			await options.delete_recovery_point(backup_id);
		}
	}
	return { ...selection, dry_run };
}
