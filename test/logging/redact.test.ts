import { describe, expect, it } from "vitest";

import { redactValue } from "../../src/logging/redact.js";

describe("redactValue", () => {
	it("redacts sensitive keys recursively", () => {
		const value_redacted = redactValue({
			password: "hunter2",
			nested: {
				hmac_secret: "top-secret",
				token: "bearer-value",
			},
		});

		expect(JSON.stringify(value_redacted)).not.toContain("hunter2");
		expect(JSON.stringify(value_redacted)).not.toContain("top-secret");
		expect(JSON.stringify(value_redacted)).not.toContain("bearer-value");
	});

	it("redacts credentials embedded in URLs and database URLs", () => {
		const value_redacted = redactValue({
			url_source: "https://alice:secret@example.com/path",
			message: "failed postgres://admin:dbpass@postgres/langfuse",
		});
		const text_redacted = JSON.stringify(value_redacted);

		expect(text_redacted).not.toContain("secret");
		expect(text_redacted).not.toContain("dbpass");
		expect(text_redacted).toContain("[REDACTED]");
	});
});
