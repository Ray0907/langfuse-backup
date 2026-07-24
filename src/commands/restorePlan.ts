import { readFile } from "node:fs/promises";

import {
	createRestorePlan,
	type RestorePlan,
	type RestorePlanOptions,
} from "../restore/restorePlan.js";

export function runRestorePlan(options: RestorePlanOptions): RestorePlan {
	return createRestorePlan(options);
}

export function formatRestorePlan(plan_restore: RestorePlan): string {
	return `${JSON.stringify(plan_restore, null, 2)}\n`;
}

export async function runRestorePlanFile(path_request: string): Promise<string> {
	const text_request = await readFile(path_request, "utf8");
	const value_request: unknown = JSON.parse(text_request);
	if (value_request === null || typeof value_request !== "object") {
		throw new Error("Restore plan request must be a JSON object");
	}
	return formatRestorePlan(createRestorePlan(value_request as RestorePlanOptions));
}
