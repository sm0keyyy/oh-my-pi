import { beforeAll, expect, test, vi } from "bun:test";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { TempDir } from "@oh-my-pi/pi-utils";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { Settings } from "../../src/config/settings";
import type {
	ExtensionReviewRequest,
	ExtensionReviewResult,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
} from "../../src/extensibility/extensions/types";
import { EventController } from "../../src/modes/controllers/event-controller";
import { RequestApprovalTool, splitReviewSections } from "../../src/tools/request-approval";
import type { ToolSession } from "../../src/tools";
import { createInteractiveModeContext } from "../helpers/interactive-mode-context";

beforeAll(async () => {
	await Settings.init({ inMemory: true });
	await initTheme(false);
});

test("result contains only verdict and section comments, rejects invalid files, and resolves local URLs", async () => {
	await using temp = await TempDir.create(`${process.cwd()}/approval-tool-`);
	const file = temp.join("plan.md");
	await Bun.write(file, "## 4. Slices\n\nBuild it.\n");
	const session: ToolSession = {
		cwd: temp.path(),
		hasUI: true,
		settings: Settings.isolated(),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		localProtocolOptions: { getArtifactsDir: () => temp.path(), getSessionId: () => "approval" },
	};
	const tool = new RequestApprovalTool(session);
	let received: ExtensionReviewRequest | undefined;
	const ui = {
		review: async (request: ExtensionReviewRequest): Promise<ExtensionReviewResult> => {
			received = request;
			return {
				kind: "verdict",
				verdict: "request-changes",
				comments: [{ section: "§4 Slices", text: "merge view and wire" }],
			};
		},
	} as ExtensionUIContext;
	const context = { hasUI: true, ui } as AgentToolContext;
	const result = await tool.execute("approval", { path: file }, undefined, undefined, context);
	expect(result.content).toEqual([
		{ type: "text", text: "Verdict: changes requested\n§4 Slices: merge view and wire" },
	]);
	expect(received?.sections).toEqual([{ id: "§4", heading: "Slices", excerpt: "## 4. Slices\n\nBuild it.\n" }]);
	await Bun.write(temp.join("wrong.txt"), "markdown");
	await expect(tool.execute("bad", { path: temp.join("wrong.txt") }, undefined, undefined, context)).rejects.toThrow();
	await Bun.write(temp.join("huge.md"), "x".repeat(1024 * 1024 + 1));
	await expect(tool.execute("big", { path: temp.join("huge.md") }, undefined, undefined, context)).rejects.toThrow();
	await Bun.write(temp.join("local", "plan.md"), "# Local\n");
	await tool.execute("local", { path: "local://plan.md" }, undefined, undefined, context);
	expect(received?.markdown).toBe("# Local\n");
	expect(
		splitReviewSections("# Top\n\n```md\n## Not a section\n```\n\n## Real\n").map(section => section.heading),
	).toEqual(["Top", "Real"]);
});

test("timeout is not approval and main review has no deadline", async () => {
	await using temp = await TempDir.create(`${process.cwd()}/approval-timeout-`);
	await Bun.write(temp.join("plan.md"), "# Plan");
	const tool = new RequestApprovalTool({
		cwd: temp.path(),
		hasUI: true,
		settings: Settings.isolated(),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
	});
	const review = vi.fn(async (_request: ExtensionReviewRequest, options?: ExtensionUIDialogOptions) => {
		expect(options?.timeout).toBeUndefined();
		return { kind: "cancelled", timedOut: true };
	});
	const result = await tool.execute("timeout", { path: "plan.md" }, undefined, undefined, {
		hasUI: true,
		ui: { review },
	} as unknown as AgentToolContext);
	expect(result.content).toEqual([{ type: "text", text: "Verdict: timed out (not approved)" }]);
	expect(result.details).toEqual({ verdict: "timed-out", comments: [] });
	expect(RequestApprovalTool.createIf({ hasUI: false } as ToolSession)).toBeNull();
});

test("status reports an approval as blocked question until the tool completes", async () => {
	const setRunStatus = vi.fn();
	const ctx = createInteractiveModeContext({ runStatus: { setRunStatus } });
	const events = new EventController(ctx);
	await events.handleEvent({
		type: "tool_execution_start",
		toolCallId: "approval",
		toolName: "request_approval",
		args: { path: "/tmp/plan.md", title: "Shipping plan" },
	});
	expect(setRunStatus.mock.calls).toContainEqual([
		{ state: "blocked", kind: "question", msg: "Approve Shipping plan?" },
	]);
	await events.handleEvent({
		type: "tool_execution_end",
		toolCallId: "approval",
		toolName: "request_approval",
		result: { content: [], details: {} },
		isError: false,
	});
	expect(setRunStatus.mock.calls.at(-1)).toEqual([{ state: "working" }]);
});
