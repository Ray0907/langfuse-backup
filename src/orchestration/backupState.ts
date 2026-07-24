export type BackupStateName =
	| "created"
	| "locked"
	| "preflight_passed"
	| "quiesced"
	| "postgres_complete"
	| "clickhouse_complete"
	| "blob_complete"
	| "verified"
	| "committed";

type ComponentName = "postgres" | "clickhouse" | "blob";

interface VerifiableReceipt {
	verified_at?: string;
}

const state_order: BackupStateName[] = [
	"created",
	"locked",
	"preflight_passed",
	"quiesced",
	"postgres_complete",
	"clickhouse_complete",
	"blob_complete",
	"verified",
	"committed",
];

export class BackupState {
	private state_current: BackupStateName = "created";
	private readonly receipts = new Map<ComponentName, VerifiableReceipt>();

	public get current(): BackupStateName {
		return this.state_current;
	}

	public recordReceipt(name_component: ComponentName, receipt: VerifiableReceipt): void {
		this.receipts.set(name_component, receipt);
	}

	public transition(state_next: BackupStateName): void {
		const index_current = state_order.indexOf(this.state_current);
		const state_expected = state_order[index_current + 1];
		if (state_next !== state_expected) {
			throw new Error(
				`Invalid backup state transition: ${this.state_current} -> ${state_next}; `
				+ `expected ${String(state_expected)}`,
			);
		}
		if (state_next === "committed") {
			this.assertReceiptsVerified();
		}
		this.state_current = state_next;
	}

	private assertReceiptsVerified(): void {
		for (const name_component of ["postgres", "clickhouse", "blob"] as const) {
			if (!this.receipts.get(name_component)?.verified_at) {
				throw new Error(`Cannot commit before ${name_component} receipt is verified`);
			}
		}
	}
}
