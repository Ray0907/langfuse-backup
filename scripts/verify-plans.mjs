import fs from "node:fs";
import path from "node:path";

var path_root = process.cwd();
var files_required = [
	"README.md",
	"docs/architecture.md",
	"docs/plans/2026-07-24-00-project-bootstrap.md",
	"docs/plans/2026-07-24-01-backup-foundation.md",
	"docs/plans/2026-07-24-02-consistency-and-blob-storage.md",
	"docs/plans/2026-07-24-03-restore-validation.md",
	"docs/plans/2026-07-24-04-oss-release.md",
	"progress.md",
];
var failures_found = [];

function addFailure(message_failure) {
	failures_found.push(message_failure);
}

function getMarkdownLinks(content_file) {
	var links_found = [];
	var regex_link = /\[[^\]]+\]\(([^)]+)\)/g;
	var match_link;

	while ((match_link = regex_link.exec(content_file)) !== null) {
		links_found.push(match_link[1]);
	}

	return links_found;
}

function checkRequiredFiles() {
	for (var file_required of files_required) {
		var path_required = path.join(path_root, file_required);

		if (!fs.existsSync(path_required)) {
			addFailure(`Missing required file: ${file_required}`);
		}
	}
}

function checkMarkdownFile(file_markdown) {
	var path_markdown = path.join(path_root, file_markdown);
	var content_markdown = fs.readFileSync(path_markdown, "utf8");
	var lines_markdown = content_markdown.split("\n");
	var count_fences = 0;

	for (var index_line = 0; index_line < lines_markdown.length; index_line += 1) {
		var content_line = lines_markdown[index_line];
		var number_line = index_line + 1;

		if (/[ \t]+$/.test(content_line)) {
			addFailure(`${file_markdown}:${number_line} has trailing whitespace`);
		}

		if (content_line.length > 100) {
			addFailure(`${file_markdown}:${number_line} exceeds 100 characters`);
		}

		if (content_line.trimStart().startsWith("```")) {
			count_fences += 1;
		}
	}

	if (count_fences % 2 !== 0) {
		addFailure(`${file_markdown} has unbalanced fenced code blocks`);
	}

	for (var link_target of getMarkdownLinks(content_markdown)) {
		if (/^(https?:|mailto:|#)/.test(link_target)) {
			continue;
		}

		var target_clean = link_target.split("#")[0];
		var path_target = path.resolve(path.dirname(path_markdown), target_clean);

		if (!fs.existsSync(path_target)) {
			addFailure(`${file_markdown} has broken link: ${link_target}`);
		}
	}
}

function checkRequiredSections() {
	var sections_required = new Map([
		["progress.md", ["## Milestones", "## Decisions", "## Loop Run"]],
		[
			"docs/architecture.md",
			["## Product Boundary", "## Consistency", "## Manifest", "## Security Boundary"],
		],
	]);

	for (var [file_section, headings_required] of sections_required) {
		var content_section = fs.readFileSync(path.join(path_root, file_section), "utf8");

		for (var heading_required of headings_required) {
			if (!content_section.includes(heading_required)) {
				addFailure(`${file_section} is missing section: ${heading_required}`);
			}
		}
	}
}

checkRequiredFiles();

for (var file_markdown of files_required) {
	if (fs.existsSync(path.join(path_root, file_markdown))) {
		checkMarkdownFile(file_markdown);
	}
}

checkRequiredSections();

if (failures_found.length > 0) {
	for (var failure_found of failures_found) {
		process.stderr.write(`${failure_found}\n`);
	}

	process.stderr.write(`Plan verification failed: ${failures_found.length} error(s).\n`);
	process.exit(1);
}

process.stdout.write(
	`Plan verification passed: ${files_required.length} Markdown files, ` +
	"0 broken links, 0 format errors.\n",
);
