import type { BackupDestination, DestinationObject } from "../destination/types.js";
import type { RecoveryManifest } from "../manifest/schema.js";
import { verifyBackupReceipts } from "../orchestration/verifyBackup.js";
import { inspectRecoveryPoint } from "./inspect.js";

export interface RecoveryPointVerification {
	manifest: RecoveryManifest;
	verified_paths: string[];
}

function assertObjectMatches(
	name_component: string,
	object_found: DestinationObject | null,
	size_expected: number,
	sha256_expected: string,
): asserts object_found is DestinationObject {
	if (
		object_found === null
		|| object_found.size_bytes !== size_expected
		|| object_found.sha256 !== sha256_expected
	) {
		throw new Error(`${name_component} artifact metadata mismatch`);
	}
}

export async function verifyRecoveryPoint(
	destination: BackupDestination,
	deployment_id: string,
	backup_id: string,
): Promise<RecoveryPointVerification> {
	const recovery_point = await inspectRecoveryPoint(
		destination,
		deployment_id,
		backup_id,
	);
	const receipts = verifyBackupReceipts(recovery_point.manifest.components);
	const metadata_postgres = await destination.statObject(
		receipts.postgres.object_path,
	);
	assertObjectMatches(
		"PostgreSQL",
		metadata_postgres,
		receipts.postgres.size_bytes,
		receipts.postgres.sha256,
	);
	const metadata_blob = await destination.statObject(
		receipts.blob.inventory_path,
	);
	assertObjectMatches(
		"Blob",
		metadata_blob,
		receipts.blob.size_bytes,
		receipts.blob.sha256,
	);

	return {
		manifest: recovery_point.manifest,
		verified_paths: [
			recovery_point.manifest_path,
			receipts.postgres.object_path,
			receipts.blob.inventory_path,
		],
	};
}
