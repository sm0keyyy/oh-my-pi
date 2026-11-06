import { afterEach, beforeEach, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type {
	ExtensionAskDialogQuestion,
	ExtensionAskDialogResult,
	ExtensionUIDialogOptions,
	ExtensionUIContext,
} from "../../src/extensibility/extensions/types";
import { answerPending, type OperatorQueueMain, startOperatorQueue } from "../../src/operator-queue";
import { ensureDirs, queuePaths } from "../../src/operator-queue/paths";
import { enqueueRequest, listPending } from "../../src/operator-queue/queue";
import {
	registerSubagentAskHost,
	subagentAskHostFor,
	unregisterSubagentAskHost,
} from "../../src/task/subagent-ask-host";
import { EventBus } from "../../src/utils/event-bus";

let root: string;
let previous: string | undefined;
let auto: string | undefined;
let dispose: (() => void) | undefined;
beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-drain-"));
	previous = process.env.ASK_BRIDGE_QUEUE_DIR;
	auto = process.env.INTERVIEW_AUTO_OPEN;
	process.env.ASK_BRIDGE_QUEUE_DIR = root;
	delete process.env.INTERVIEW_AUTO_OPEN;
	await ensureDirs(queuePaths());
});
afterEach(async () => {
	dispose?.();
	dispose = undefined;
	await Bun.sleep(30);
	if (previous === undefined) delete process.env.ASK_BRIDGE_QUEUE_DIR;
	else process.env.ASK_BRIDGE_QUEUE_DIR = previous;
	if (auto === undefined) delete process.env.INTERVIEW_AUTO_OPEN;
	else process.env.INTERVIEW_AUTO_OPEN = auto;
	await fs.rm(root, { recursive: true, force: true });
});
const questions = [{ id: "choice", question: "Which?", options: [{ label: "Yes" }] }];
async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 6_000;
	while (!(await predicate())) {
		if (Date.now() > deadline) throw new Error("Interview state did not arrive");
		await Bun.sleep(10);
	}
}
function app(
	ask: (
		questions: ExtensionAskDialogQuestion[],
		options?: ExtensionUIDialogOptions,
	) => Promise<ExtensionAskDialogResult | undefined>,
	askUi?: OperatorQueueMain["askUi"],
) {
	let widget: string[] | undefined;
	const notices: string[] = [];
	const ui = {
		timeoutStartsOnPresentation: true,
		askDialog: ask,
		notify: (text: string) => {
			notices.push(text);
		},
		setWidget: (_key: string, lines: string[] | undefined) => {
			widget = lines;
		},
	} as ExtensionUIContext;
	const service = startOperatorQueue({ ui, askUi, sessionId: () => "main" });
	dispose = service.dispose;
	return { ui, notices, widget: () => widget };
}

// Real timers cover fs.watch delivery and the platform debounce/retry contract together.
it("debounces own arrivals for one second, keeps foreign interviews pending, and removes the watcher and widget at disposal", async () => {
	const presented: string[] = [];
	const ui = app(async q => {
		presented.push(q[0]!.question);
		return {
			kind: "submit",
			results: q.map(item => ({
				...item,
				options: item.options.map(o => o.label),
				multi: false,
				selectedOptions: ["Yes"],
			})),
		};
	});
	await enqueueRequest("foreign", "fixture", questions, "elsewhere");
	await enqueueRequest("own", "fixture", questions, "main");
	await Bun.sleep(700);
	expect(presented).toEqual([]);
	await until(() => ui.notices.length === 1);
	expect(presented).toEqual(["Which?"]);
	expect((await listPending(queuePaths())).map(r => r.corrId)).toEqual(["foreign"]);
	await until(() => ui.widget()?.[0] === "Interviews · 1 · /interview-next");
	dispose!();
	expect(ui.widget()).toBeUndefined();
	await enqueueRequest("after-dispose", "fixture", questions, "main");
	await Bun.sleep(1_150);
	expect(presented).toHaveLength(1);
});

it("cancellation stops the batch and 300-second native idle expiry leaves the request pending", async () => {
	let calls = 0;
	let idleBudget: number | undefined;
	const ui = app(async (_q, options) => {
		calls++;
		idleBudget = options?.timeout;
		options?.onTimeout?.();
		return undefined;
	});
	await enqueueRequest("one", "fixture", questions, "main");
	await enqueueRequest("two", "fixture", questions, "main");
	await until(() => ui.notices.length === 1);
	expect(idleBudget).toBe(300_000);
	expect(await fs.readdir(queuePaths().answered)).toEqual([]);
	expect(await fs.readdir(queuePaths().pending)).toHaveLength(2);
	await Bun.sleep(1_150);
	expect(calls).toBe(1);
	expect(ui.notices[0]).toContain("No answer after 300 s");
});

it("retries a foreign live holder after three seconds without requiring a new pending file", async () => {
	const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 10000)"], {
		stdout: "ignore",
		stderr: "ignore",
	});
	try {
		await Bun.write(queuePaths().lock, JSON.stringify({ owner: "wizard", pid: child.pid }));
		const presented: number[] = [];
		const ui = app(async () => {
			presented.push(Date.now());
			return undefined;
		});
		await enqueueRequest("locked", "fixture", questions, "main");
		await until(() => ui.widget()?.[0] === "Interviews · 1 · /interview-next");
		await Bun.sleep(150);
		expect(presented).toEqual([]);
		child.kill();
		await child.exited;
		const released = Date.now();
		await until(() => presented.length === 1);
		expect(presented[0]! - released).toBeGreaterThan(2_500);
		expect(ui.notices).toHaveLength(1);
		expect((await listPending(queuePaths())).map(r => r.corrId)).toEqual(["locked"]);
	} finally {
		child.kill();
		await child.exited;
	}
}, 10_000);

it("shares FIFO order with subagent asks and resolves a replaced host during the same main session", async () => {
	process.env.INTERVIEW_AUTO_OPEN = "false";
	const bus = new EventBus();
	const dialogs: Array<{
		questions: ExtensionAskDialogQuestion[];
		resolve(result: ExtensionAskDialogResult | undefined): void;
	}> = [];
	let resolved = 0;
	const main = app(
		async (q, options) => {
			const pending = Promise.withResolvers<ExtensionAskDialogResult | undefined>();
			dialogs.push({ questions: q, resolve: pending.resolve });
			options?.signal?.addEventListener("abort", () => pending.resolve(undefined), { once: true });
			options?.onTimeoutStart?.();
			return pending.promise;
		},
		() => {
			resolved++;
			return subagentAskHostFor(bus)?.externalUi();
		},
	);
	let host = registerSubagentAskHost({ main: main.ui, subagentEventBus: bus });
	const submit = (index: number): void => {
		const dialog = dialogs[index]!;
		dialog.resolve({
			kind: "submit",
			results: dialog.questions.map(q => ({
				id: q.id,
				question: q.question,
				options: ["Yes"],
				multi: false,
				selectedOptions: ["Yes"],
			})),
		});
	};
	try {
		const first = host.uiFor("first", "First").askDialog!(questions);
		await enqueueRequest("interview", "fixture", questions, "main");
		const drain = answerPending({ ui: main.ui, sessionId: () => "main" });
		await until(() => resolved === 1);
		const last = host.uiFor("last", "Last").askDialog!(questions);
		expect(dialogs.map(d => d.questions[0]!.question)).toEqual(["First: Which?"]);
		submit(0);
		await first;
		await until(() => dialogs.length === 2);
		expect(dialogs[1]!.questions[0]!.question).toBe("Which?");
		submit(1);
		await until(() => dialogs.length === 3);
		expect(dialogs[2]!.questions[0]!.question).toBe("Last: Which?");
		submit(2);
		await Promise.all([last, drain]);

		host = registerSubagentAskHost({ main: main.ui, subagentEventBus: bus });
		const replacementAsk = host.uiFor("replacement", "Replacement").askDialog!(questions);
		await enqueueRequest("after-replacement", "fixture", questions, "main");
		const replacedDrain = answerPending({ ui: main.ui, sessionId: () => "main" });
		await until(() => resolved === 2);
		expect(dialogs).toHaveLength(4);
		submit(3);
		await replacementAsk;
		await until(() => dialogs.length === 5);
		expect(dialogs[4]!.questions[0]!.question).toBe("Which?");
		submit(4);
		await replacedDrain;
		expect((await fs.readdir(queuePaths().answered)).sort()).toEqual(["after-replacement.json", "interview.json"]);
	} finally {
		unregisterSubagentAskHost(host);
	}
});
