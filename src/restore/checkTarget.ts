export interface RestoreTarget {
	deployment_id: string;
	langfuse_version: string;
	postgres_version: string;
	clickhouse_version: string;
	postgres_empty: boolean;
	clickhouse_empty: boolean;
	blob_empty: boolean;
	secret_references: string[];
}

export interface RestoreVersionSources {
	langfuse_version: string;
	postgres_version: string;
	clickhouse_version: string;
}

export interface RestoreVersionCheck {
	component: "langfuse" | "postgres" | "clickhouse";
	source_version: string;
	target_version: string;
	compatible: true;
}

export interface CheckRestoreTargetOptions {
	source_deployment_id: string;
	target: RestoreTarget;
	source_versions: RestoreVersionSources;
	required_secrets: string[];
}

function getVersionParts(name_component: string, value_version: string): number[] {
	const match_version = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(value_version);
	if (match_version === null) {
		throw new Error(`${name_component} version is invalid: ${value_version}`);
	}
	return match_version.slice(1).map((part_version) => Number(part_version ?? 0));
}

function assertVersion(
	name_component: string,
	source_version: string,
	target_version: string,
	parts_required: number,
): void {
	const source_parts = getVersionParts(name_component, source_version);
	const target_parts = getVersionParts(name_component, target_version);
	const is_compatible = source_parts
		.slice(0, parts_required)
		.every((part_source, index_part) => part_source === target_parts[index_part]);
	if (!is_compatible) {
		throw new Error(
			`${name_component} versions are incompatible: `
			+ `${source_version} -> ${target_version}`,
		);
	}
}

function assertEmptyTarget(target: RestoreTarget): void {
	const components_nonempty = [
		["PostgreSQL", target.postgres_empty],
		["ClickHouse", target.clickhouse_empty],
		["blob storage", target.blob_empty],
	].filter(([, is_empty]) => !is_empty).map(([name_component]) => name_component);
	if (components_nonempty.length > 0) {
		throw new Error(`Target is not empty: ${components_nonempty.join(", ")}`);
	}
}

export function checkRestoreTarget(
	options: CheckRestoreTargetOptions,
): RestoreVersionCheck[] {
	if (options.source_deployment_id === options.target.deployment_id) {
		throw new Error("Source and target deployment IDs must differ");
	}
	assertEmptyTarget(options.target);
	assertVersion(
		"Langfuse",
		options.source_versions.langfuse_version,
		options.target.langfuse_version,
		1,
	);
	assertVersion(
		"PostgreSQL",
		options.source_versions.postgres_version,
		options.target.postgres_version,
		1,
	);
	assertVersion(
		"ClickHouse",
		options.source_versions.clickhouse_version,
		options.target.clickhouse_version,
		2,
	);

	const names_available = new Set(options.target.secret_references);
	const names_missing = options.required_secrets.filter((name_secret) =>
		!names_available.has(name_secret));
	if (names_missing.length > 0) {
		throw new Error(`Missing required secret references: ${names_missing.join(", ")}`);
	}

	return [
		{
			component: "langfuse",
			source_version: options.source_versions.langfuse_version,
			target_version: options.target.langfuse_version,
			compatible: true,
		},
		{
			component: "postgres",
			source_version: options.source_versions.postgres_version,
			target_version: options.target.postgres_version,
			compatible: true,
		},
		{
			component: "clickhouse",
			source_version: options.source_versions.clickhouse_version,
			target_version: options.target.clickhouse_version,
			compatible: true,
		},
	];
}
