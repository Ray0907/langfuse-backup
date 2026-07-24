const value_redacted = "[REDACTED]";
const pattern_sensitive_key = /(authorization|credential|database_url|hmac|password|secret|token)/i;
const pattern_url_credentials = /([a-z][a-z0-9+.-]*:\/\/)([^:\s/@]+):([^@\s/]+)@/gi;
const pattern_bearer = /\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi;

function redactString(value_input: string): string {
	return value_input
		.replace(pattern_url_credentials, `$1${value_redacted}@`)
		.replace(pattern_bearer, `$1 ${value_redacted}`);
}

export function redactValue(value_input: unknown, key_parent = ""): unknown {
	if (pattern_sensitive_key.test(key_parent)) {
		return value_redacted;
	}

	if (typeof value_input === "string") {
		return redactString(value_input);
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
