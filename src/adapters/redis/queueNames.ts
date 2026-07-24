export interface IngestionShardCounts {
	ingestion: number;
	secondary_ingestion: number;
	otel_ingestion: number;
	secondary_otel_ingestion: number;
}

function getShardNames(name_base: string, count_shards: number): string[] {
	if (!Number.isSafeInteger(count_shards) || count_shards < 1) {
		throw new Error(`Invalid shard count for ${name_base}`);
	}
	return Array.from(
		{ length: count_shards },
		(_value_unused, index_shard) =>
			`${name_base}${index_shard === 0 ? "" : `-${index_shard}`}`,
	);
}

export function getIngestionQueueNames(
	counts_shards: IngestionShardCounts,
): string[] {
	return [
		...getShardNames("ingestion-queue", counts_shards.ingestion),
		...getShardNames(
			"secondary-ingestion-queue",
			counts_shards.secondary_ingestion,
		),
		...getShardNames("otel-ingestion-queue", counts_shards.otel_ingestion),
		...getShardNames(
			"secondary-otel-ingestion-queue",
			counts_shards.secondary_otel_ingestion,
		),
	];
}
