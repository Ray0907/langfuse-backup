import { z } from "zod";

const TimestampSchema = z.iso.datetime({ offset: true });
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const NonNegativeIntegerSchema = z.number().int().nonnegative();

const ReceiptBaseSchema = z.object({
	started_at: TimestampSchema,
	completed_at: TimestampSchema,
	verified_at: TimestampSchema,
	size_bytes: NonNegativeIntegerSchema,
}).passthrough();

export const PostgresReceiptSchema = ReceiptBaseSchema.extend({
	provider: z.literal("postgres"),
	object_path: z.string().min(1),
	sha256: Sha256Schema,
	client_version: z.string().min(1),
	server_version: z.string().min(1),
});

export const ClickhouseReceiptSchema = ReceiptBaseSchema.extend({
	provider: z.literal("clickhouse"),
	operation_id: z.string().min(1),
	database: z.string().min(1),
	object_prefix: z.string().min(1),
	status: z.literal("BACKUP_CREATED"),
	server_version: z.string().min(1),
});

export const BlobReceiptSchema = ReceiptBaseSchema.extend({
	provider: z.enum(["gcs_inventory", "s3_copy"]),
	inventory_path: z.string().min(1),
	object_count: NonNegativeIntegerSchema,
	sha256: Sha256Schema,
});

export const ManifestSchema = z.object({
	schema_version: z.string().regex(/^1\.\d+\.\d+$/),
	backup_id: z.string().min(1),
	deployment_id: z.string().min(1),
	langfuse_version: z.string().min(1).optional(),
	created_at: TimestampSchema,
	committed_at: TimestampSchema,
	tool: z.object({
		version: z.string().min(1),
		source_revision: z.string().min(1),
	}).passthrough(),
	consistency: z.object({
		mode: z.enum(["coordinated", "online"]),
		boundary_at: TimestampSchema,
		queue_drained_at: TimestampSchema.optional(),
	}).passthrough().superRefine((value_consistency, context) => {
		if (value_consistency.mode === "coordinated"
			&& value_consistency.queue_drained_at === undefined) {
			context.addIssue({
				code: "custom",
				path: ["queue_drained_at"],
				message: "Coordinated manifests require queue_drained_at",
			});
		}
	}),
	components: z.object({
		postgres: PostgresReceiptSchema,
		clickhouse: ClickhouseReceiptSchema,
		blob: BlobReceiptSchema,
	}).passthrough(),
	required_secrets: z.array(z.string().min(1)),
}).passthrough();

export type RecoveryManifest = z.infer<typeof ManifestSchema>;
export type PostgresReceipt = z.infer<typeof PostgresReceiptSchema>;
export type ClickhouseReceipt = z.infer<typeof ClickhouseReceiptSchema>;
export type BlobReceipt = z.infer<typeof BlobReceiptSchema>;
