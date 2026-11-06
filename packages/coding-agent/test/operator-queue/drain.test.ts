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
import { startOperatorQueue } from "../../src/operator-queue";
import { ensureDirs, queuePaths } from "../../src/operator-queue/paths";
import { enqueueRequest, listPending } from "../../src/operator-queue/queue";

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
	const service = startOperatorQueue({ ui, sessionId: () => "main" });
	dispose = service.dispose;
	return { notices, widget: () => widget };
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
