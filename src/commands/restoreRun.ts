import {
	runRestore,
	type RunRestoreOptions,
	type RunRestoreResult,
} from "../restore/runRestore.js";

export function runRestoreCommand(
	options: RunRestoreOptions,
): Promise<RunRestoreResult> {
	return runRestore(options);
}
