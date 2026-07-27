import {
	GetObjectCommand,
	ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import type { S3Client } from "@aws-sdk/client-s3";

import { redactError } from "../logging/redact.js";
import type { S3BlobSource } from "./copyBlobPrefix.js";

export function createS3ObjectSource(
	client_s3: S3Client,
	name_bucket: string,
): S3BlobSource {
	return {
		async listPage(request_page) {
			let result_list;
			try {
				result_list = await client_s3.send(new ListObjectsV2Command({
					Bucket: name_bucket,
					Prefix: request_page.prefix,
					...(request_page.page_token === undefined
						? {}
						: { ContinuationToken: request_page.page_token }),
				}));
			} catch (error) {
				throw redactError(error, "S3 object listing failed");
			}
			const objects = (result_list.Contents ?? []).map((object_source) => {
				if (object_source.Key === undefined || object_source.ETag === undefined
					|| object_source.Size === undefined) {
					throw new Error("S3 object listing metadata is incomplete");
				}
				return {
					key: object_source.Key,
					etag: object_source.ETag,
					size_bytes: object_source.Size,
				};
			});
			return {
				objects,
				...(result_list.NextContinuationToken === undefined
					? {}
					: { next_page_token: result_list.NextContinuationToken }),
			};
		},
		async openObject(key_object) {
			let result_object;
			try {
				result_object = await client_s3.send(new GetObjectCommand({
					Bucket: name_bucket,
					Key: key_object,
				}));
			} catch (error) {
				throw redactError(error, "S3 object download failed");
			}
			if (result_object.Body === undefined
				|| !(Symbol.asyncIterator in Object(result_object.Body))) {
				throw new Error(`S3 object ${key_object} did not return a stream`);
			}
			return result_object.Body as unknown as AsyncIterable<Uint8Array>;
		},
	};
}
