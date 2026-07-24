import type { BackupDestination } from "../destination/types.js";
import { readManifest } from "../manifest/readManifest.js";
import type { RecoveryManifest } from "../manifest/schema.js";

export interface RecoveryPointSummary {
	manifest_path: string;
	manifest: RecoveryManifest;
}

export function getRecoveryPointPrefix(deployment_id: string): string {
	return `deployments/${encodeURIComponent(deployment_id)}/backups/`;
}

export function getRecoveryPointManifestPath(
	deployment_id: string,
	backup_id: string,
): string {
	return `${getRecoveryPointPrefix(deployment_id)}`
		+ `${encodeURIComponent(backup_id)}/manifest.json`;
}

export async function listRecoveryPoints(
	destination: BackupDestination,
	deployment_id: string,
): Promise<RecoveryPointSummary[]> {
	const prefix_recovery = getRecoveryPointPrefix(deployment_id);
	const objects_found = await destination.listObjects(prefix_recovery);
	const recovery_points: RecoveryPointSummary[] = [];

	for (const object_found of objects_found) {
		if (!object_found.path.endsWith("/manifest.json")) {
			continue;
		}
		try {
			const manifest = readManifest(
				(await destination.getObject(object_found.path)).toString("utf8"),
			);
			if (
				manifest.deployment_id !== deployment_id
				|| object_found.path !== getRecoveryPointManifestPath(
					deployment_id,
					manifest.backup_id,
				)
			) {
				continue;
			}
			recovery_points.push({
				manifest_path: object_found.path,
				manifest,
			});
		} catch {
			continue;
		}
	}

	return recovery_points.sort((item_left, item_right) =>
		item_right.manifest.committed_at.localeCompare(
			item_left.manifest.committed_at,
		));
}
