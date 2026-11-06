import { afterEach, beforeEach, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../../src/config/settings";
import { entryPath, queuePaths } from "../../src/operator-queue/paths";
import { completeInterview, enqueueRequest, listPending } from "../../src/operator-queue/queue";
import { AskOperatorResultTool, AskOperatorTool } from "../../src/operator-queue/tools";
import { BUILTIN_TOOLS, resolveBuiltinToolPlan, type ToolSession } from "../../src/tools";

let root: string;
let previous: string | undefined;
let timeout: string | undefined;
beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-operator-tools-"));
	previous = process.env.ASK_BRIDGE_QUEUE_DIR;
	timeout = process.env.ASK_BRIDGE_TIMEOUT_MS;
	process.env.ASK_BRIDGE_QUEUE_DIR = path.join(root, "queue");
});
afterEach(async () => {
	if (previous === undefined) delete process.env.ASK_BRIDGE_QUEUE_DIR;
	else process.env.ASK_BRIDGE_QUEUE_DIR = previous;
	if (timeout === undefined) delete process.env.ASK_BRIDGE_TIMEOUT_MS;
	else process.env.ASK_BRIDGE_TIMEOUT_MS = timeout;
	await fs.rm(root, { recursive: true, force: true });
});
const questions = [{ id: "go", question: "Proceed?", options: [{ label: "Yes" }, { label: "No" }] }];
function session(file: string | null = null): ToolSession {
	return {
		cwd: root,
		hasUI: false,
		settings: Settings.isolated({}),
		getSessionFile: () => file,
		getSessionId: () => "child",
		getSessionSpawns: () => null,
		skipPythonPreflight: true,
	};
}

it("offers both built-ins in default headless sessions and queues a child request for its top-level session", async () => {
	const parent = path.join(root, "parent.jsonl");
	await Bun.write(parent, `${JSON.stringify({ type: "session", id: "parent-id" })}\n`);
	const source = session(path.join(root, "parent", "child.jsonl"));
	const plan = await resolveBuiltinToolPlan(source);
	for (const name of ["ask_operator", "ask_operator_result"]) expect(plan.names).toContain(name);
	const tool = await BUILTIN_TOOLS.ask_operator(source);
	expect(tool?.concurrency).toBe("shared");
	const ask = new AskOperatorTool(source);
	for (const count of [0, 9])
		expect(
			(await ask.execute("bad", { questions: Array.from({ length: count }, () => questions[0]!) })).content,
		).toMatchObject([{ text: expect.stringContaining("Error:") }]);
	const queued = await ask.execute("queue", { questions });
	const id = queued.details?.id;
	if (!id) throw new Error("Missing queued interview id");
	const content = queued.content[0];
	if (content?.type !== "text") throw new Error("Missing queued result text");
	expect(JSON.parse(content.text)).toMatchObject({ status: "queued", id });
	expect((await listPending(queuePaths()))[0]?.interview).toMatchObject({ session: "parent-id", from: "child" });
});

it("returns formatted answers and details, replays a consumed id, and rejects unknown ids", async () => {
	const request = await enqueueRequest("receipt", "fixture", questions);
	const paths = queuePaths();
	await completeInterview(
		paths,
		"receipt",
		request,
		{ go: { selected: ["Yes"], customInput: "details", note: "operator note" } },
		"interview note",
	);
	const tool = new AskOperatorResultTool();
	const answer = await tool.execute("wait", { id: "receipt" });
	expect(answer.content).toEqual([
		{
			type: "text",
			text: "User answers:\n- go: Yes\n  User added note: operator note\nUser added note: interview note",
		},
	]);
	expect(answer.details?.results).toMatchObject([
		{ id: "go", question: "Proceed?", selectedOptions: ["Yes"], customInput: "details", timedOut: false },
	]);
	expect(await tool.execute("replay", { id: "receipt" })).toEqual(answer);
	for (const id of ["missing", "../escape"])
		expect((await tool.execute("missing", { id })).details).toEqual({ unknownId: true });
});

it("withdraws a timed-out interview and replays the timeout notice instead of asking again", async () => {
	process.env.ASK_BRIDGE_TIMEOUT_MS = "5";
	await enqueueRequest("expired", "fixture", questions);
	const tool = new AskOperatorResultTool();
	const outcome = await tool.execute("timeout", { id: "expired" });
	expect(outcome.details).toEqual({ answers: {}, timedOut: true, notifyMain: "INTERVIEW-TIMEOUT expired" });
	expect(await Bun.file(entryPath(queuePaths().pending, "expired")).exists()).toBe(false);
	expect(await Bun.file(entryPath(queuePaths().expired, "expired")).exists()).toBe(true);
	expect(await tool.execute("replay", { id: "expired" })).toEqual(outcome);
});
