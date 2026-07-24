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
