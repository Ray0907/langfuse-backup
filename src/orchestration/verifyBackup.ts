import {
	BlobReceiptSchema,
	ClickhouseReceiptSchema,
	PostgresReceiptSchema,
	type BlobReceipt,
	type ClickhouseReceipt,
	type PostgresReceipt,
} from "../manifest/schema.js";

export interface BackupReceipts {
	postgres: PostgresReceipt;
	clickhouse: ClickhouseReceipt;
	blob: BlobReceipt;
}

function assertVerified(name_component: string, verified_at: string | undefined): void {
	if (verified_at === undefined || Number.isNaN(Date.parse(verified_at))) {
		throw new Error(`${name_component} receipt is not verified`);
	}
}

export function verifyBackupReceipts(receipts_backup: BackupReceipts): BackupReceipts {
	const postgres = PostgresReceiptSchema.parse(receipts_backup.postgres);
	const clickhouse = ClickhouseReceiptSchema.parse(receipts_backup.clickhouse);
	const blob = BlobReceiptSchema.parse(receipts_backup.blob);

	assertVerified("PostgreSQL", postgres.verified_at);
	assertVerified("ClickHouse", clickhouse.verified_at);
	assertVerified("blob", blob.verified_at);

	return { postgres, clickhouse, blob };
}
