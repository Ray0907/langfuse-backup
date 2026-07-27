import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { defineConfig } from "tsup";

interface PackageMetadata {
	version: string;
}

const package_metadata = JSON.parse(
	readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as PackageMetadata;
const revision_source = process.env.SOURCE_REVISION
	?? execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();

export default defineConfig({
	entry: {
		cli: "src/index.ts",
	},
	format: ["esm"],
	target: "node24",
	clean: true,
	dts: false,
	sourcemap: true,
	bundle: true,
	banner: {
		js: "#!/usr/bin/env node",
	},
	define: {
		__LANGFUSE_BACKUP_VERSION__: JSON.stringify(package_metadata.version),
		__LANGFUSE_BACKUP_REVISION__: JSON.stringify(revision_source),
	},
	outDir: "dist",
	outExtension: () => ({ js: ".js" }),
});
