import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadBundledAgents } from "@oh-my-pi/pi-coding-agent/task/agents";
import { seanceIsolationOptions } from "@oh-my-pi/pi-coding-agent/task/seance-policy";
import { BUILTIN_TOOLS, resolveBuiltinToolPlan, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { buildOutputValidator } from "@oh-my-pi/pi-coding-agent/tools/output-schema-validator";

const codeTools = ["codegraph", "ast_grep", "lsp"];
const interviewTools = ["ask_operator", "ask_operator_result"];

describe("bundled agent contracts", () => {
	it("resolves every bundled agent's built-ins without widening seance", async () => {
		for (const agent of loadBundledAgents()) {
			const seance = agent.name === "seance";
			const session: ToolSession = {
				cwd: import.meta.dir,
				hasUI: false,
				getSessionFile: () => null,
				getSessionSpawns: () => "",
				skipPythonPreflight: true,
				taskDepth: 1,
				settings: Settings.isolated({
					"codegraph.enabled": true,
					"astGrep.enabled": true,
					"lsp.enabled": true,
				}),
				...(seance ? seanceIsolationOptions(import.meta.dir) : {}),
			};
			const plan = await resolveBuiltinToolPlan(session, agent.tools);
			const external = (agent.tools ?? []).filter(name => !Object.hasOwn(BUILTIN_TOOLS, name));
			if (seance) {
				expect(plan.names).toEqual(["read", "grep", "glob"]);
				expect(external).toEqual([]);
			} else {
				for (const name of codeTools) expect(plan.names).toContain(name);
				if (agent.tools) {
					expect(external).toEqual([]);
					for (const name of interviewTools) expect(plan.names).toContain(name);
				} else {
					// Workers inherit all built-ins and additive extension tools, not a narrower allowlist.
					expect(["task", "sonic"]).toContain(agent.name);
					for (const name of ["edit", "write", "bash"]) expect(plan.names).toContain(name);
				}
			}
		}
	});

	it("requires query evidence in specialist results and accepts incremental query sections", () => {
		const results: Record<string, Record<string, unknown>> = {
			reviewer: { overall_correctness: "correct", explanation: "No defects found.", confidence: 1 },
			"security-reviewer": { coverage_summary: "Reviewed the assigned scope." },
			scout: { summary: "Mapped the caller.", files: [], architecture: "One caller." },
		};
		for (const agent of loadBundledAgents()) {
			const result = results[agent.name];
			if (!result) continue;
			const { validator, error } = buildOutputValidator(agent.output);
			if (!validator) throw new Error(error ?? `Missing output validator for ${agent.name}`);
			expect(validator.validate(result).success).toBe(false);
			expect(
				validator.validate({ ...result, queries: ["codegraph: explore caller", "ast_grep: call($$$ARGS)"] })
					.success,
			).toBe(true);
			expect(validator.validateSection.get("queries")?.("codegraph: explore caller").success).toBe(true);
			expect(validator.validateSection.get("queries")?.(42).success).toBe(false);
		}
	});
});
