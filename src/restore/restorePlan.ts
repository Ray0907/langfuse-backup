import type { DestinationObject } from "../destination/types.js";
import type { RecoveryManifest } from "../manifest/schema.js";
import {
	checkRestoreTarget,
	type RestoreTarget,
	type RestoreVersionCheck,
} from "./checkTarget.js";

export interface RestoreArtifactEvidence {
	postgres: DestinationObject | null;
	blob: DestinationObject | null;
	clickhouse_valid: boolean;
}

export interface RestorePlanOptions {
	manifest: RecoveryManifest;
	source_langfuse_version?: string;
	target: RestoreTarget;
	artifacts: RestoreArtifactEvidence;
	accept_online_consistency?: boolean;
}

export type RestoreActionComponent =
	| "target_lock"
	| "blob"
	| "postgres"
	| "clickhouse"
	| "health_checks"
	| "smoke_tests"
	| "report"
	| "target_unlock";

export interface RestoreAction {
	order: number;
	component: RestoreActionComponent;
	destructive: boolean;
	description: string;
}

export interface RestorePlan {
	backup_id: string;
	source_deployment_id: string;
	target_deployment_id: string;
	requires_downtime: true;
	estimated_artifact_size_bytes: number;
	required_secrets: string[];
	version_checks: RestoreVersionCheck[];
	actions: RestoreAction[];
}

function assertArtifact(
	name_component: string,
	object_artifact: DestinationObject | null,
	path_expected: string,
	size_expected: number,
	sha256_expected: string,
): void {
	if (object_artifact === null) {
		throw new Error(`${name_component} artifact is missing`);
	}
	if (object_artifact.path !== path_expected
		|| object_artifact.size_bytes !== size_expected
		|| object_artifact.sha256 !== sha256_expected) {
		throw new Error(`${name_component} artifact has a size or checksum mismatch`);
	}
}

function assertArtifacts(options: RestorePlanOptions): void {
	const { manifest, artifacts } = options;
	assertArtifact(
		"PostgreSQL",
		artifacts.postgres,
		manifest.components.postgres.object_path,
		manifest.components.postgres.size_bytes,
		manifest.components.postgres.sha256,
	);
	assertArtifact(
		"blob",
		artifacts.blob,
		manifest.components.blob.inventory_path,
		manifest.components.blob.size_bytes,
		manifest.components.blob.sha256,
	);
	if (!artifacts.clickhouse_valid) {
		throw new Error("ClickHouse backup prefix is missing or mismatched");
	}
}

function createActions(): RestoreAction[] {
	const actions: Array<Omit<RestoreAction, "order">> = [
		{ component: "target_lock", destructive: false, description: "Lock target" },
		{ component: "blob", destructive: true, description: "Restore blob objects" },
		{ component: "postgres", destructive: true, description: "Restore PostgreSQL" },
		{ component: "clickhouse", destructive: true, description: "Restore ClickHouse" },
		{ component: "health_checks", destructive: false, description: "Check health" },
		{ component: "smoke_tests", destructive: false, description: "Run smoke tests" },
		{ component: "report", destructive: false, description: "Write restore report" },
		{ component: "target_unlock", destructive: false, description: "Unlock target" },
	];
	return actions.map((action_restore, index_action) => ({
		order: index_action + 1,
		...action_restore,
	}));
}

export function createRestorePlan(options: RestorePlanOptions): RestorePlan {
	const { manifest } = options;
	const source_langfuse_version = manifest.langfuse_version
		?? options.source_langfuse_version;
	if (source_langfuse_version === undefined) {
		throw new Error("Manifest does not record a Langfuse version");
	}
	if (manifest.consistency.mode === "online"
		&& options.accept_online_consistency !== true) {
		throw new Error(
			"Online backup restore requires --accept-online-consistency",
		);
	}
	const version_checks = checkRestoreTarget({
		source_deployment_id: manifest.deployment_id,
		target: options.target,
		source_versions: {
			langfuse_version: source_langfuse_version,
			postgres_version: manifest.components.postgres.server_version,
			clickhouse_version: manifest.components.clickhouse.server_version,
		},
		required_secrets: manifest.required_secrets,
	});
	assertArtifacts(options);

	return {
		backup_id: manifest.backup_id,
		source_deployment_id: manifest.deployment_id,
		target_deployment_id: options.target.deployment_id,
		requires_downtime: true,
		estimated_artifact_size_bytes:
			manifest.components.postgres.size_bytes
			+ manifest.components.clickhouse.size_bytes
			+ manifest.components.blob.size_bytes,
		required_secrets: [...manifest.required_secrets].sort(),
		version_checks,
		actions: createActions(),
	};
}
