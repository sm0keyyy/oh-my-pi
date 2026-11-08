import { expect, test } from "bun:test";
import { isRecord, TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../src/config/settings";
import { createRpcConnection, type RpcHostAdapter } from "../src/modes/rpc/rpc-mode";
import { registerPaneSupervisor } from "../src/rex-panes/supervise";
import { normalizeRunbook } from "../src/runbook/entries";
import { createAgentSession } from "../src/sdk";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL } from "../src/task";
import { startUsagePoller, onUsageChange } from "../src/usage";
import { EventBus } from "../src/utils/event-bus";
import { fixture } from "./runbook/fixture";
import "../src/usage/settings";

async function harness() {
	const temp = await TempDir.create("@rpc-j-");
	const { session } = await createAgentSession({
		cwd: temp.path(),
		agentDir: temp.join("agent"),
		toolNames: [],
		enableMCP: false,
		enableLsp: false,
		disableExtensionDiscovery: true,
		settings: Settings.isolated({ "compaction.enabled": false }),
	});
	let input!: ReadableStreamDefaultController<Uint8Array>;
	const responses = new Map<string, (frame: Record<string, unknown>) => void>();
	const bus = new EventBus();
	const host: RpcHostAdapter = {};
	const connection = await createRpcConnection({
		session,
		host,
		subagentEventBus: bus,
		input: new ReadableStream({
			start(controller) {
				input = controller;
			},
		}),
		writer: {
			write(lines) {
				for (const line of lines) {
					if (!line) continue;
					const frame: unknown = JSON.parse(line);
					if (isRecord(frame) && typeof frame.id === "string") responses.get(frame.id)?.(frame);
				}
			},
		},
	});
	let sequence = 0;
	return {
		temp,
		bus,
		host,
		async send(command: object) {
			const id = String(++sequence);
			const response = Promise.withResolvers<Record<string, unknown>>();
			responses.set(id, response.resolve);
			input.enqueue(new TextEncoder().encode(JSON.stringify({ ...command, id }) + "\n"));
			try {
				return await response.promise;
			} finally {
				responses.delete(id);
			}
		},
		async [Symbol.asyncDispose]() {
			input.close();
			await connection.done;
			await connection.dispose();
			await session.dispose();
			await temp[Symbol.asyncDispose]();
		},
	};
}

test("supervise RPC holds and reopens the requested pane; no host reports unknown-block", async () => {
	await using rpc = await harness();
	expect(await rpc.send({ type: "pane_crashed", blockId: "missing" })).toMatchObject({ data: { known: false } });
	expect(await rpc.send({ type: "reopen_pane", blockId: "missing" })).toMatchObject({
		data: { ok: false, reason: "unknown-block" },
	});
	let crashed = false;
	const unregister = registerPaneSupervisor({
		markCrashed(id) {
			return (crashed = id === "block-1");
		},
		async reopen(id) {
			return id === "block-1" && crashed ? { ok: true } : { ok: false, reason: "unknown-block" };
		},
	});
	try {
		expect(await rpc.send({ type: "pane_crashed", blockId: "block-1" })).toMatchObject({ data: { known: true } });
		expect(await rpc.send({ type: "reopen_pane", blockId: "block-1" })).toMatchObject({ data: { ok: true } });
		expect(await rpc.send({ type: "pane_crashed", blockId: "../bad" })).toMatchObject({ success: false });
		const panes: string[] = [];
		rpc.host.handleCommand = async command => {
			if (command.type !== "toggle_pane") return;
			panes.push(command.pane);
			return { id: command.id, type: "response", command: "toggle_pane", success: true, data: { open: true } };
		};
		for (const pane of ["usage", "dashboard", "feed"])
			expect(await rpc.send({ type: "toggle_pane", pane })).toMatchObject({ data: { open: true } });
		expect(panes).toEqual(["usage", "dashboard", "feed"]);
		expect(await rpc.send({ type: "toggle_pane", pane: "bad" })).toMatchObject({ success: false });
		await Bun.write(rpc.temp.join("view.md"), "# Comments\n");
		expect(await rpc.send({ type: "view_markdown", path: rpc.temp.join("view.md") })).toMatchObject({
			data: { opened: false },
		});
		for (const path of ["https://outside/view.md", "bad\0.md", rpc.temp.join("view.txt")])
			expect(await rpc.send({ type: "view_markdown", path })).toMatchObject({ success: false });
	} finally {
		unregister();
	}
}, 30000);

test("runbook RPC requires an explicit command, validates the pick and passes admission outcomes through", async () => {
	await using rpc = await harness();
	const book = fixture();
	const details = normalizeRunbook(
		{ title: "RPC book", steps: [{ title: "Print", command: "printf rpc-runbook-result" }] },
		crypto.randomUUID(),
	);
	book.owner.add(details);
	book.save(details);
	try {
		expect(book.deliveries).toEqual([]);
		for (const command of [
			{ runbookId: details.runbookId, step: 0 },
			{ runbookId: details.runbookId, step: "1" },
			{ runbookId: "../book", step: 1 },
		])
			expect(await rpc.send({ type: "run_runbook_step", ...command })).toMatchObject({ success: false });
		expect(await rpc.send({ type: "run_runbook_step", runbookId: "missing", step: 1 })).toMatchObject({
			data: { ok: false, reason: "unknown-runbook" },
		});
		expect(await rpc.send({ type: "run_runbook_step", runbookId: details.runbookId, step: 1 })).toMatchObject({
			data: { ok: true, jobId: expect.any(String) },
		});
		await book.settle();
		expect(book.deliveries.join("\n")).toContain("rpc-runbook-result");
		expect(await rpc.send({ type: "run_runbook_step", runbookId: details.runbookId, step: "all" })).toMatchObject({
			data: { ok: true },
		});
		await book.settle();
		await book.jobs.dispose();
		expect(await rpc.send({ type: "run_runbook_step", runbookId: details.runbookId, step: 1 })).toMatchObject({
			data: { ok: false, reason: "running" },
		});
	} finally {
		await book.close();
	}
}, 30000);

test("usage and thread RPC expose redacted usage and one owned transcript, not arbitrary paths", async () => {
	await using rpc = await harness();
	const published = Promise.withResolvers<void>();
	const unsubscribe = onUsageChange(() => published.resolve());
	const poller = startUsagePoller({
		settings: Settings.isolated(),
		notice() {},
		async run(argv) {
			return {
				exitCode: 0,
				stdout: argv.includes("dashboard")
					? JSON.stringify({
							schemaVersion: 1,
							providers: [
								{
									id: "codex",
									name: "Codex",
									identity: { email: "fixture@example.invalid", plan: "Pro" },
									windows: [{ kind: "session", label: "Session", usedPercent: 42 }],
								},
							],
						})
					: "[]",
			};
		},
	});
	try {
		await published.promise;
		const usage = await rpc.send({ type: "get_usage" });
		expect(usage).toMatchObject({
			data: {
				snapshot: { providers: [{ id: "codex", label: "Codex", plan: "Pro", windows: [{ usedPercent: 42 }] }] },
			},
		});
		expect(JSON.stringify(usage)).not.toContain("@");
		const sessionFile = `${import.meta.dir}/fixtures/threads/revived.jsonl`;
		rpc.bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "Worker",
			index: 0,
			agent: "task",
			agentSource: "bundled",
			status: "started",
			sessionFile,
		});
		rpc.bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "Worker",
			index: 0,
			agent: "task",
			agentSource: "bundled",
			status: "completed",
			sessionFile,
		});
		expect(await rpc.send({ type: "get_subagent_thread", subagentId: "Worker" })).toMatchObject({
			data: {
				thread: {
					agentId: "Worker",
					sessionFile,
					items: [
						{ kind: "brief", text: "First assignment." },
						{ kind: "result" },
						{ kind: "operator" },
						{ kind: "reply" },
						{ kind: "result" },
					],
				},
			},
		});
		for (const subagentId of ["Unknown", sessionFile])
			expect(await rpc.send({ type: "get_subagent_thread", subagentId })).toMatchObject({
				success: false,
				error: "Unknown subagent",
			});
	} finally {
		poller.dispose();
		unsubscribe();
	}
}, 30000);
