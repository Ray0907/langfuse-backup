import { defineConfig } from "tsup";

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
	outDir: "dist",
	outExtension: () => ({ js: ".js" }),
});
