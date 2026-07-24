import type { BackupDestination } from "../destination/types.js";
import { readManifest } from "../manifest/readManifest.js";
import type { RecoveryManifest } from "../manifest/schema.js";
import { getRecoveryPointManifestPath } from "./list.js";

export interface InspectedRecoveryPoint {
	manifest_path: string;
	manifest: RecoveryManifest;
}

export async function inspectRecoveryPoint(
	destination: BackupDestination,
	deployment_id: string,
	backup_id: string,
): Promise<InspectedRecoveryPoint> {
	const manifest_path = getRecoveryPointManifestPath(deployment_id, backup_id);
	const manifest = readManifest(
		(await destination.getObject(manifest_path)).toString("utf8"),
	);
	if (
		manifest.deployment_id !== deployment_id
		|| manifest.backup_id !== backup_id
	) {
		throw new Error("Recovery-point identity does not match its object path");
	}
	return { manifest_path, manifest };
}
