import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: ["test/**/*.test.ts"],
		exclude: ["test/e2e/**/*.test.ts"],
		testTimeout: 10_000,
		hookTimeout: 10_000,
	},
});
