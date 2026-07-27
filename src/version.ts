declare const __LANGFUSE_BACKUP_VERSION__: string;
declare const __LANGFUSE_BACKUP_REVISION__: string;

export const version_tool = typeof __LANGFUSE_BACKUP_VERSION__ === "undefined"
	? "0.1.0-dev"
	: __LANGFUSE_BACKUP_VERSION__;
export const revision_source = typeof __LANGFUSE_BACKUP_REVISION__ === "undefined"
	? "source"
	: __LANGFUSE_BACKUP_REVISION__;

export function getVersionText(): string {
	return `${version_tool} (${revision_source})`;
}
