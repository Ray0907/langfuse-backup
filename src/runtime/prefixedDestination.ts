import type {
	BackupDestination,
	DestinationObject,
} from "../destination/types.js";

function normalizePrefix(prefix_object: string): string {
	return prefix_object
		.split("/")
		.filter((part_path) => part_path !== "")
		.join("/");
}

export function getPrefixedPath(prefix_object: string, path_object: string): string {
	const prefix_normalized = normalizePrefix(prefix_object);
	const path_normalized = path_object.replace(/^\/+/, "");
	return prefix_normalized === ""
		? path_normalized
		: `${prefix_normalized}/${path_normalized}`;
}

function removePrefix(prefix_object: string, object_found: DestinationObject): DestinationObject {
	const prefix_normalized = normalizePrefix(prefix_object);
	if (prefix_normalized === "") {
		return object_found;
	}
	const prefix_with_slash = `${prefix_normalized}/`;
	if (!object_found.path.startsWith(prefix_with_slash)) {
		throw new Error("Destination returned an object outside the configured prefix");
	}
	return {
		...object_found,
		path: object_found.path.slice(prefix_with_slash.length),
	};
}

export function createPrefixedDestination(
	destination_base: BackupDestination,
	prefix_object: string,
): BackupDestination {
	return {
		async putObject(path_object, data_object, options_put) {
			const object_created = await destination_base.putObject(
				getPrefixedPath(prefix_object, path_object),
				data_object,
				options_put,
			);
			return removePrefix(prefix_object, object_created);
		},
		getObject: async (path_object) =>
			destination_base.getObject(getPrefixedPath(prefix_object, path_object)),
		async statObject(path_object) {
			const object_found = await destination_base.statObject(
				getPrefixedPath(prefix_object, path_object),
			);
			return object_found === null
				? null
				: removePrefix(prefix_object, object_found);
		},
		deleteObject: async (path_object, generation) =>
			destination_base.deleteObject(
				getPrefixedPath(prefix_object, path_object),
				generation,
			),
		async listObjects(prefix_list) {
			const objects_found = await destination_base.listObjects(
				getPrefixedPath(prefix_object, prefix_list),
			);
			return objects_found.map((object_found) =>
				removePrefix(prefix_object, object_found));
		},
	};
}
