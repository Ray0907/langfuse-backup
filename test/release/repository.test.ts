import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const path_root = resolve(import.meta.dirname, "../..");
const paths_workflow = [
	".github/workflows/ci.yml",
	".github/workflows/release.yml",
	".github/workflows/reproducible-build.yml",
	".github/workflows/scorecard.yml",
];

function collectUses(value_node: unknown): string[] {
	if (Array.isArray(value_node)) {
		return value_node.flatMap(collectUses);
	}
	if (value_node === null || typeof value_node !== "object") {
		return [];
	}
	const record_node = value_node as Record<string, unknown>;
	return [
		...(typeof record_node.uses === "string" ? [record_node.uses] : []),
		...Object.values(record_node).flatMap(collectUses),
	];
}

interface WorkflowStep {
	run?: string;
	uses?: string;
	with?: Record<string, unknown>;
}

function collectWorkflowSteps(value_workflow: unknown): WorkflowStep[][] {
	if (value_workflow === null || typeof value_workflow !== "object") {
		return [];
	}
	const jobs_workflow = (value_workflow as {
		jobs?: Record<string, { steps?: WorkflowStep[] }>;
	}).jobs;
	if (jobs_workflow === undefined) {
		return [];
	}
	return Object.values(jobs_workflow)
		.map((job_workflow) => job_workflow.steps ?? []);
}

describe("public repository release metadata", () => {
	it.each(paths_workflow)("parses %s and pins every action to a commit", async (path_file) => {
		const workflow = parse(
			await readFile(resolve(path_root, path_file), "utf8"),
		) as unknown;
		const uses_action = collectUses(workflow);

		expect(uses_action.length).toBeGreaterThan(0);
		for (const action_used of uses_action) {
			expect(action_used).toMatch(/^[^@\s]+@[a-f0-9]{40}$/);
		}
	});

	it.each(paths_workflow)(
		"makes pnpm available before setup-node caching in %s",
		async (path_file) => {
			const workflow = parse(
				await readFile(resolve(path_root, path_file), "utf8"),
			) as unknown;

			for (const steps_workflow of collectWorkflowSteps(workflow)) {
				const index_node = steps_workflow.findIndex((step_workflow) =>
					step_workflow.uses?.startsWith("actions/setup-node@")
					&& step_workflow.with?.cache === "pnpm");
				if (index_node < 0) {
					continue;
				}
				const steps_before = steps_workflow.slice(0, index_node);
				expect(steps_before.some((step_workflow) =>
					step_workflow.run?.includes("corepack enable")
					|| step_workflow.uses?.startsWith("pnpm/action-setup@"),
				)).toBe(true);
			}
		},
	);

	it("keeps protected release gates ahead of publishing", async () => {
		const text_release = await readFile(
			resolve(path_root, ".github/workflows/release.yml"),
			"utf8",
		);

		expect(text_release).toContain("gitleaks/gitleaks-action@");
		expect(text_release.match(/aquasecurity\/trivy-action@/g)).toHaveLength(2);
		expect(text_release).toContain("bash scripts/run-recovery-e2e.sh");
		expect(text_release).toContain("environment: release");
		expect(text_release).toContain("cosign sign --yes");
	});

	it("allows the generated hidden SPDX path to be uploaded", async () => {
		const workflow = parse(
			await readFile(
				resolve(path_root, ".github/workflows/reproducible-build.yml"),
				"utf8",
			),
		) as unknown;
		const steps_workflow = collectWorkflowSteps(workflow).flat();
		const step_upload = steps_workflow.find((step_workflow) =>
			step_workflow.uses?.startsWith("actions/upload-artifact@")
			&& step_workflow.with?.path === ".artifacts/*.spdx.json");

		expect(step_upload?.with?.["include-hidden-files"]).toBe(true);
	});

	it("contains no launch placeholders in public entry points", async () => {
		const text_public = await Promise.all([
			"README.md",
			"CHANGELOG.md",
			"SECURITY.md",
			"docs/releasing.md",
		].map(async (path_file) => readFile(resolve(path_root, path_file), "utf8")));

		expect(text_public.join("\n")).not.toMatch(/OWNER\/REPOSITORY|NOT_IMPLEMENTED|TBD/);
	});
});
