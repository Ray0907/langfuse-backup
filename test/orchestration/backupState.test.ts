import { describe, expect, it } from "vitest";

import {
	BackupStateMachine,
	assertCanCommitManifest,
} from "../../src/orchestration/backupState.js";

describe("BackupStateMachine", () => {
	it("rejects transitions that skip required states", () => {
		const machine_state = new BackupStateMachine();

		expect(() => machine_state.transition("preflight_passed")).toThrow(/created.*locked/i);
	});

	it("accepts the documented state sequence", () => {
		const machine_state = new BackupStateMachine();
		const states_expected = [
			"locked",
			"preflight_passed",
			"quiesced",
			"postgres_complete",
			"clickhouse_complete",
			"blob_complete",
			"verified",
			"committed",
		] as const;

		for (const state_expected of states_expected) {
			machine_state.transition(state_expected);
		}

		expect(machine_state.current).toBe("committed");
	});
});

describe("assertCanCommitManifest", () => {
	it("rejects commit until every required receipt is verified", () => {
		expect(() => assertCanCommitManifest({
			postgres: true,
			clickhouse: true,
			blob: false,
		})).toThrow(/blob/i);
	});

	it("accepts commit when every required receipt is verified", () => {
		expect(() => assertCanCommitManifest({
			postgres: true,
			clickhouse: true,
			blob: true,
		})).not.toThrow();
	});
});
