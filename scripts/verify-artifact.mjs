import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { parse } from "yaml";

const path_root = resolve(import.meta.dirname, "..");
const path_artifacts = resolve(path_root, ".artifacts");
const package_metadata = JSON.parse(
	await readFile(resolve(path_root, "package.json"), "utf8"),
);
const revision_source = process.env.SOURCE_REVISION
	?? execFileSync("git", ["rev-parse", "HEAD"], {
		cwd: path_root,
		encoding: "utf8",
	}).trim();
const time_source = Number(execFileSync(
	"git",
	["show", "-s", "--format=%ct", revision_source],
	{ cwd: path_root, encoding: "utf8" },
).trim());

assertMatch(package_metadata.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, "version");
assertEqual(package_metadata.packageManager, "pnpm@11.0.0", "package manager");
assertEqual(package_metadata.engines?.node, ">=24", "Node.js engine");

const text_dockerfile = await readFile(resolve(path_root, "Dockerfile"), "utf8");
const references_digest = text_dockerfile.match(/@sha256:[a-f0-9]{64}/g) ?? [];
if (references_digest.length < 2) {
	throw new Error("Dockerfile must pin every base image by digest");
}

const text_cli = await readFile(resolve(path_root, "dist/cli.js"), "utf8");
if (!text_cli.startsWith("#!/usr/bin/env node")) {
	throw new Error("Built CLI is missing its executable shebang");
}
const text_version = execFileSync(
	process.execPath,
	[resolve(path_root, "dist/cli.js"), "--version"],
	{ cwd: path_root, encoding: "utf8" },
).trim();
if (!text_version.includes(package_metadata.version)
	|| !text_version.includes(revision_source)) {
	throw new Error(`CLI version evidence is incomplete: ${text_version}`);
}

const document_sbom = await createSpdxDocument();
await mkdir(path_artifacts, { recursive: true });
const path_sbom = resolve(
	path_artifacts,
	`langfuse-backup-${package_metadata.version}.spdx.json`,
);
await writeFile(path_sbom, `${JSON.stringify(document_sbom, null, 2)}\n`, {
	mode: 0o600,
});
await verifyImageIfRequested();

process.stdout.write(
	`Artifact verification passed: version ${package_metadata.version}, `
	+ `revision ${revision_source}, ${document_sbom.packages.length} SBOM packages.\n`,
);

async function createSpdxDocument() {
	const lockfile = parse(await readFile(resolve(path_root, "pnpm-lock.yaml"), "utf8"));
	const package_keys = getProductionPackageKeys(lockfile);
	const packages_lock = package_keys
		.map((key_package) => [
			key_package,
			lockfile.packages?.[key_package],
		])
		.map(([key_package, value_package]) =>
			createSpdxPackage(key_package, value_package))
		.sort((left_package, right_package) =>
			left_package.name.localeCompare(right_package.name)
			|| left_package.versionInfo.localeCompare(right_package.versionInfo));
	const id_root = "SPDXRef-Package-langfuse-backup";
	return {
		spdxVersion: "SPDX-2.3",
		dataLicense: "CC0-1.0",
		SPDXID: "SPDXRef-DOCUMENT",
		name: `langfuse-backup-${package_metadata.version}`,
		documentNamespace: "https://spdx.org/spdxdocs/langfuse-backup/"
			+ `${package_metadata.version}/${revision_source}`,
		creationInfo: {
			created: new Date(time_source * 1000).toISOString(),
			creators: ["Tool: langfuse-backup-verify-artifact"],
		},
		packages: [
			{
				name: "langfuse-backup",
				SPDXID: id_root,
				versionInfo: package_metadata.version,
				downloadLocation: "NOASSERTION",
				filesAnalyzed: false,
				licenseConcluded: "MIT",
				licenseDeclared: "MIT",
				copyrightText: "NOASSERTION",
			},
			...packages_lock,
		],
		relationships: [
			{
				spdxElementId: "SPDXRef-DOCUMENT",
				relationshipType: "DESCRIBES",
				relatedSpdxElement: id_root,
			},
			...packages_lock.map((item_package) => ({
				spdxElementId: id_root,
				relationshipType: "DEPENDS_ON",
				relatedSpdxElement: item_package.SPDXID,
			})),
		],
	};
}

function getProductionPackageKeys(lockfile) {
	const packages_lock = lockfile.packages ?? {};
	const snapshots_lock = lockfile.snapshots ?? {};
	const dependencies_root = lockfile.importers?.["."]?.dependencies ?? {};
	const keys_pending = Object.entries(dependencies_root).map(
		([name_package, dependency]) =>
			resolvePackageKey(packages_lock, name_package, dependency.version),
	);
	const keys_seen = new Set();

	while (keys_pending.length > 0) {
		const key_package = keys_pending.pop();
		if (key_package === undefined || keys_seen.has(key_package)) {
			continue;
		}
		keys_seen.add(key_package);
		const snapshot_package = snapshots_lock[key_package] ?? {};
		const dependencies_package = {
			...(snapshot_package.dependencies ?? {}),
			...(snapshot_package.optionalDependencies ?? {}),
		};
		for (const [name_dependency, version_dependency] of
			Object.entries(dependencies_package)) {
			keys_pending.push(resolvePackageKey(
				packages_lock,
				name_dependency,
				version_dependency,
			));
		}
	}
	return [...keys_seen].sort();
}

function resolvePackageKey(packages_lock, name_package, version_package) {
	const key_exact = `${name_package}@${version_package}`;
	if (key_exact in packages_lock) {
		return key_exact;
	}
	const version_base = String(version_package).replace(/\(.+$/, "");
	const key_base = `${name_package}@${version_base}`;
	const keys_matching = Object.keys(packages_lock).filter((key_package) =>
		key_package === key_base || key_package.startsWith(`${key_base}(`));
	if (keys_matching.length !== 1) {
		throw new Error(
			`Unable to resolve production package ${name_package}@${version_package}`,
		);
	}
	return keys_matching[0];
}

function createSpdxPackage(key_package, value_package) {
	const key_clean = key_package.replace(/\(.+$/, "");
	const index_version = key_clean.lastIndexOf("@");
	if (index_version < 1) {
		throw new Error(`Unable to parse lockfile package: ${key_package}`);
	}
	const name_package = key_clean.slice(0, index_version);
	const version_package = key_clean.slice(index_version + 1);
	const integrity_package = value_package?.resolution?.integrity;
	const checksums = typeof integrity_package === "string"
		? [createIntegrityChecksum(integrity_package)]
		: undefined;
	return {
		name: name_package,
		SPDXID: `SPDXRef-Package-${createHash("sha256")
			.update(key_clean).digest("hex").slice(0, 24)}`,
		versionInfo: version_package,
		downloadLocation: "NOASSERTION",
		filesAnalyzed: false,
		licenseConcluded: "NOASSERTION",
		licenseDeclared: "NOASSERTION",
		copyrightText: "NOASSERTION",
		...(checksums === undefined ? {} : { checksums }),
	};
}

function createIntegrityChecksum(value_integrity) {
	const [name_algorithm, value_base64] = value_integrity.split("-", 2);
	if (name_algorithm !== "sha512" || value_base64 === undefined) {
		throw new Error(`Unsupported lockfile integrity: ${value_integrity}`);
	}
	return {
		algorithm: "SHA512",
		checksumValue: Buffer.from(value_base64, "base64").toString("hex"),
	};
}

async function verifyImageIfRequested() {
	const name_image = process.env.ARTIFACT_IMAGE ?? "langfuse-backup:test";
	const metadata_image = JSON.parse(execFileSync(
		"docker",
		["image", "inspect", name_image],
		{ cwd: path_root, encoding: "utf8" },
	))[0];
	assertEqual(metadata_image.Config?.User, "10001:10001", "image user");
	assertEqual(
		metadata_image.Config?.Labels?.["org.opencontainers.image.version"],
		package_metadata.version,
		"image version label",
	);
	assertEqual(
		metadata_image.Config?.Labels?.["org.opencontainers.image.revision"],
		process.env.SOURCE_REVISION === undefined ? "unknown" : revision_source,
		"image revision label",
	);
}

function assertEqual(value_actual, value_expected, name_value) {
	if (value_actual !== value_expected) {
		throw new Error(
			`Unexpected ${name_value}: ${String(value_actual)} != ${value_expected}`,
		);
	}
}

function assertMatch(value_actual, pattern_expected, name_value) {
	if (typeof value_actual !== "string" || !pattern_expected.test(value_actual)) {
		throw new Error(`Invalid ${name_value}: ${String(value_actual)}`);
	}
}
