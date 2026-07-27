const value_redacted = "[REDACTED]";
const names_sensitive = [
	"access_key",
	"authorization",
	"credential",
	"database_url",
	"hmac",
	"password",
	"private_key",
	"secret",
	"signed_url",
	"token",
];
const pattern_sensitive_key = new RegExp(`(${names_sensitive.join("|")})`, "i");
const pattern_url_credentials = /([a-z][a-z0-9+.-]*:\/\/)([^:\s/@]+):([^@\s/]+)@/gi;
const pattern_authorization = /\b(Basic|Bearer)\s+[A-Za-z0-9._~+/=-]+/gi;
const names_cli = names_sensitive
	.map((name_secret) => name_secret.replace("_", "[-_]"));
const source_secret_value = "(\"[^\"]*\"|'[^']*'|[^\\s,;&]+)";
const pattern_cli_secret = new RegExp(
	`(--(?:${names_cli.join("|")})(?:=|\\s+))`
	+ source_secret_value,
	"gi",
);
const names_assignment = [
	...names_sensitive,
	"x-amz-credential",
	"x-amz-security-token",
	"x-amz-signature",
	"x-goog-credential",
	"x-goog-signature",
];
const pattern_secret_assignment = new RegExp(
	`(\\b(?:${names_assignment.join("|")})\\b\\s*(?:=|:)\\s*)`
	+ source_secret_value,
	"gi",
);
const pattern_access_key = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g;
const pattern_private_key =
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

export function redactText(value_input: string): string {
	return value_input
		.replace(pattern_url_credentials, `$1${value_redacted}@`)
		.replace(pattern_authorization, `$1 ${value_redacted}`)
		.replace(pattern_cli_secret, `$1${value_redacted}`)
		.replace(pattern_secret_assignment, `$1${value_redacted}`)
		.replace(pattern_access_key, value_redacted)
		.replace(pattern_private_key, value_redacted);
}

export function redactError(error_input: unknown, context_error = ""): Error {
	const message_error = error_input instanceof Error
		? error_input.message
		: String(error_input);
	const message_context = context_error === ""
		? ""
		: `${context_error}: `;
	const error_redacted = new Error(`${message_context}${redactText(message_error)}`);
	error_redacted.name = error_input instanceof Error ? error_input.name : "Error";
	if (error_input !== null && typeof error_input === "object" && "code" in error_input) {
		const code_error = Reflect.get(error_input, "code");
		if (typeof code_error === "number" || typeof code_error === "string") {
			Object.defineProperty(error_redacted, "code", {
				value: code_error,
				enumerable: true,
			});
		}
	}
	return error_redacted;
}

export function redactValue(value_input: unknown, key_parent = ""): unknown {
	if (pattern_sensitive_key.test(key_parent)) {
		return value_redacted;
	}

	if (typeof value_input === "string") {
		return redactText(value_input);
	}

	if (Array.isArray(value_input)) {
		return value_input.map((item_value) => redactValue(item_value));
	}

	if (value_input !== null && typeof value_input === "object") {
		return Object.fromEntries(
			Object.entries(value_input).map(([key_value, item_value]) => [
				key_value,
				redactValue(item_value, key_value),
			]),
		);
	}

	return value_input;
}
