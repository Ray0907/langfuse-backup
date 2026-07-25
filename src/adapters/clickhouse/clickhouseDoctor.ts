import type { ClickhouseQuery } from "./queryBackupStatus.js";

export async function getClickhouseVersion(query: ClickhouseQuery): Promise<string> {
	const result_version = await query("SELECT version() AS version FORMAT JSON");
	const version_value = result_version.data[0]?.version;
	if (typeof version_value !== "string" || version_value.length === 0) {
		throw new Error("ClickHouse version response is missing");
	}
	return version_value;
}

export function createHttpClickhouseQuery(options: {
	endpoint: string;
	username?: string;
	password?: string;
	fetch_impl?: typeof fetch;
}): ClickhouseQuery {
	const fetch_impl = options.fetch_impl ?? fetch;
	return async (text_query) => {
		const headers_request = new Headers({
			"content-type": "text/plain; charset=utf-8",
		});
		if (options.username !== undefined || options.password !== undefined) {
			const credentials_basic = Buffer.from(
				`${options.username ?? "default"}:${options.password ?? ""}`,
			).toString("base64");
			headers_request.set("authorization", `Basic ${credentials_basic}`);
		}
		const response_query = await fetch_impl(options.endpoint, {
			method: "POST",
			headers: headers_request,
			body: text_query,
		});
		if (!response_query.ok) {
			const text_error = await response_query.text();
			throw new Error(`ClickHouse query failed (${response_query.status}): ${text_error}`);
		}
		const text_response = await response_query.text();
		if (text_response.trim() === "") {
			return { data: [] };
		}
		return JSON.parse(text_response) as { data: Array<Record<string, unknown>> };
	};
}
