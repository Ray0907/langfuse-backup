import { describe, expect, it } from "vitest";

import { createProgram } from "../src/cli.js";

describe("CLI", () => {
	it("lists every supported top-level command", () => {
		const program = createProgram({
			write_output: () => undefined,
			write_error: () => undefined,
		});

		const text_help = program.helpInformation();
		expect(text_help).toContain("langfuse-backup");
		expect(text_help).toContain("doctor");
		expect(text_help).toContain("create");
		expect(text_help).toContain("list");
		expect(text_help).toContain("inspect");
		expect(text_help).toContain("verify");
		expect(text_help).toContain("restore");
	});
});
