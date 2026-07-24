export interface ClickhouseQueryResult {
	data: Array<Record<string, unknown>>;
}

export type ClickhouseQuery = (text_query: string) => Promise<ClickhouseQueryResult>;

export interface ClickhouseBackupStatus {
	status: string;
	error: string;
	num_files: number;
	total_size: number;
}

function getString(row_status: Record<string, unknown>, key_value: string): string {
	const value_field = row_status[key_value];
	return value_field === undefined || value_field === null ? "" : String(value_field);
}

export async function queryBackupStatus(
	query: ClickhouseQuery,
	operation_id: string,
): Promise<ClickhouseBackupStatus> {
	const operation_escaped = operation_id.replaceAll("'", "''");
	const result_status = await query(
		"SELECT status, error, num_files, total_size "
		+ "FROM system.backups "
		+ `WHERE id = '${operation_escaped}' `
		+ "ORDER BY start_time DESC LIMIT 1 FORMAT JSON",
	);
	const row_status = result_status.data[0];
	if (row_status === undefined) {
		return {
			status: "PENDING",
			error: "",
			num_files: 0,
			total_size: 0,
		};
	}

	return {
		status: getString(row_status, "status"),
		error: getString(row_status, "error"),
		num_files: Number(getString(row_status, "num_files") || 0),
		total_size: Number(getString(row_status, "total_size") || 0),
	};
}
