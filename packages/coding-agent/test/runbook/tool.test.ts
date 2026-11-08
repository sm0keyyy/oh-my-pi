import { expect, test } from "bun:test";
import { RunbookTool } from "../../src/runbook/tool";
import { runRunbook } from "../../src/runbook/registry";
import { fixture } from "./fixture";
import { runbookLines } from "@oh-my-pi/pi-tui/tools/runbook";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AgentSession } from "../../src/session/agent-session";
import { AuthStorage } from "../../src/session/auth-storage";
import { ModelRegistry } from "../../src/config/model-registry";
import { convertToLlm } from "../../src/session/messages";
import { AsyncJobManager } from "../../src/async/job-manager";

test("single tool publishes steps and hosts without running commands", async () => {
	const invoked: string[] = [];
	const f = fixture({
		local: async step => {
			invoked.push(step.command);
			return { exitCode: 7, output: "failed-tail" };
		},
	});
	try {
		const tool = new RunbookTool(f.session);
		const result = await tool.execute("call", {
			title: "Release",
			steps: [
				{ title: "First", command: "one" },
				{ title: "Second", command: "two" },
				{ title: "Remote", command: "three", host: "unraid" },
			],
		});
		expect(invoked).toEqual([]);
		expect(result.content[0]).toMatchObject({ text: expect.stringContaining(result.details!.runbookId) });
		f.save(result.details!);
		const lines = runbookLines(result.details!).join("\n");
		expect(lines).toContain("1. First · mac · ready");
		expect(lines).toContain("3. Remote · unraid · ready");
		const started = await runRunbook(result.details!.runbookId, 2, "tui");
		expect(started.ok).toBe(true);
		await f.settle();
		expect(invoked).toEqual(["two"]);
		expect(f.deliveries).toHaveLength(1);
		expect(f.deliveries[0]).toContain('step 2 "Second" on mac: exit 7');
		expect(f.deliveries[0]).toContain("failed-tail");
		expect(runbookLines(result.details!).join("\n")).toContain("Second · mac · exit 7");
	} finally {
		await f.close();
	}
});

test("single rejects invalid runbook boundaries before registration", async () => {
	const f = fixture();
	try {
		const tool = new RunbookTool(f.session);
		await expect(tool.execute("empty", { title: "Bad", steps: [] })).rejects.toThrow();
		await expect(
			tool.execute("long", { title: "Bad", steps: [{ title: "Bad", command: "é".repeat(2049) }] }),
		).rejects.toThrow();
		await expect(
			tool.execute("count", {
				title: "Bad",
				steps: Array.from({ length: 21 }, () => ({ title: "Bad", command: "true" })),
			}),
		).rejects.toThrow();
		expect(f.jobs.getAllJobs()).toHaveLength(0);
	} finally {
		await f.close();
	}
});

test.each([false, true])("single completion reaches the owning model once when running=%s", async running => {
	const f = fixture({ local: async () => ({ exitCode: 5, output: "RUNBOOK_CAPTURE" }) });
	const auth = await AuthStorage.create(":memory:");
	auth.keys.setRuntime("anthropic", "test-key");
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let first = true;
	const mock = createMockModel({
		handler: async () => {
			if (first && running) {
				first = false;
				entered.resolve();
				await release.promise;
			}
			return { content: ["Done"] };
		},
	});
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model: getBundledModel("anthropic", "claude-sonnet-4-5")!, systemPrompt: ["Test"], tools: [] },
		convertToLlm,
		streamFn: mock.stream,
	});
	const live = new AgentSession({
		agent,
		sessionManager: f.journal,
		settings: f.session.settings,
		modelRegistry: new ModelRegistry(auth),
		agentId: f.agentId,
		asyncJobManager: f.jobs,
	});
	let turn = Promise.resolve(false);
	try {
		const result = await new RunbookTool(f.session).execute("delivery", {
			title: "Delivery",
			steps: [{ title: "One", command: "ignored" }],
		});
		f.save(result.details!);
		if (running) {
			turn = live.prompt("Work");
			await entered.promise;
			expect(live.isStreaming).toBe(true);
		}
		await runRunbook(result.details!.runbookId, 1, "tui");
		await f.jobs.waitForAll();
		release.resolve();
		await turn;
		await live.settleAsyncWork();
		const messages = mock.calls.flatMap(call => call.context.messages);
		expect(
			messages.some(message =>
				typeof message.content === "string"
					? message.content.includes("RUNBOOK_CAPTURE")
					: message.content.some(part => part.type === "text" && part.text.includes("RUNBOOK_CAPTURE")),
			),
		).toBe(true);
		expect(
			f.journal.getEntries().filter(entry => entry.type === "custom_message" && entry.customType === "async-result"),
		).toHaveLength(1);
	} finally {
		release.resolve();
		await turn;
		await live.dispose();
		auth.close();
		await f.close();
	}
});

test("a failed step records its error without disabling later Run picks", async () => {
	let reject = true;
	const f = fixture({
		local: async () => {
			if (reject) {
				reject = false;
				throw new Error("runner unavailable");
			}
			return { exitCode: 0, output: "retry succeeded" };
		},
	});
	try {
		const result = await new RunbookTool(f.session).execute("failure", {
			title: "Retry",
			steps: [{ title: "Step", command: "ignored" }],
		});
		f.save(result.details!);
		await runRunbook(result.details!.runbookId, 1, "tui");
		await f.settle();
		expect(f.deliveries[0]).toContain("exit -1");
		expect(f.deliveries[0]).toContain("runner unavailable");
		expect((await runRunbook(result.details!.runbookId, 1, "tui")).ok).toBe(true);
		await f.settle();
		expect(f.deliveries[1]).toContain("retry succeeded");
		await expect(
			new RunbookTool(f.session).execute("next", { title: "Next", steps: [{ title: "Next", command: "ignored" }] }),
		).resolves.toBeDefined();
	} finally {
		await f.close();
	}
});

test("job admission failure records exit -1 and allows retry after capacity frees", async () => {
	const f = fixture({ local: async () => ({ exitCode: 0, output: "admitted" }) });
	const jobs = new AsyncJobManager({ maxRunningJobs: 1 });
	const gate = Promise.withResolvers<string>();
	f.session.asyncJobManager = jobs;
	jobs.registerDeliverySink(f.agentId, () => {});
	jobs.register("bash", "occupied", () => gate.promise, { ownerId: f.agentId });
	try {
		const result = await new RunbookTool(f.session).execute("admission", {
			title: "Admission",
			steps: [{ title: "Step", command: "ignored" }],
		});
		f.save(result.details!);
		expect(await runRunbook(result.details!.runbookId, 1, "tui")).toEqual({ ok: false, reason: "running" });
		expect(runbookLines(result.details!).join("\n")).toContain("exit -1");
		expect(runbookLines(result.details!).join("\n")).toContain("Background job limit reached");
		expect(f.journal.getEntries()).toContainEqual(
			expect.objectContaining({
				type: "custom",
				customType: "runbook-run",
				data: {
					runbookId: result.details!.runbookId,
					steps: [
						expect.objectContaining({
							n: 1,
							exitCode: -1,
							tail: expect.stringContaining("Background job limit reached"),
						}),
					],
				},
			}),
		);
		gate.resolve("released");
		await jobs.waitForAll();
		await jobs.drainDeliveries({ timeoutMs: 2000 });
		expect((await runRunbook(result.details!.runbookId, 1, "tui")).ok).toBe(true);
		await jobs.waitForAll();
		await jobs.drainDeliveries({ timeoutMs: 2000 });
		expect(runbookLines(result.details!).join("\n")).toContain("admitted");
	} finally {
		gate.resolve("released");
		await f.close();
		await jobs.dispose();
	}
});
