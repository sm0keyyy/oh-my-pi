import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import type { AgentToolCall, SpeculativeOperationSink } from "@oh-my-pi/pi-agent-core";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { AsyncJobManager } from "../../src/async";
import { openTodoStore } from "../../src/beads";
import { ModelRegistry } from "../../src/config/model-registry";
import { IrcBus } from "../../src/irc/bus";
import { AgentLifecycleManager } from "../../src/registry/agent-lifecycle";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { AgentStorage } from "../../src/session/agent-storage";
import { TodoTracker } from "../../src/session/todo-tracker";
import { TaskTool } from "../../src/task";
import * as discovery from "../../src/task/discovery";
import * as executor from "../../src/task/executor";
import * as isolationRunner from "../../src/task/isolation-runner";
import { formatTaskResultSummary } from "../../src/task/result-summary";
import { stopSubagent } from "../../src/task/run-controls";
import type { TaskLaunchSession } from "../../src/task/speculative-launch";
import { cfgTaskBatch, cfgTaskEnableLsp, cfgTaskMaxRecursionDepth, cfgTaskPrewalk } from "../../src/task/settings";
import { getTaskSchema, taskItemSchema, taskSchema } from "../../src/task/types";
import { cfgAsyncEnabled } from "../../src/tools/settings";
import { getLatestTodoPhasesFromEntries } from "../../src/tools/todo";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { createTodoBeadsFixture } from "../helpers/todo-beads";

const cleanup: Array<() => Promise<void>> = [];
const SOURCE = "test/todo-task-link";
const agent = {
	name: "task",
	description: "task",
	systemPrompt: "Complete the assignment.",
	source: "bundled" as const,
};

function result(id: string, overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		task: "Build adapter",
		exitCode: 0,
		output: "Adapter complete.",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 1,
		...overrides,
	};
}

function text(value: { content: Array<{ type: string; text?: string }> }): string {
	return value.content.flatMap(part => (part.type === "text" ? [part.text ?? ""] : [])).join("\n");
}

async function parent(detached = false) {
	const fixture = await createTodoBeadsFixture();
	cleanup.push(fixture.cleanup);
	fixture.session.getSessionSpawns = () => "*";
	fixture.session.persistTodoPhases = phases => {
		fixture.manager.appendCustomEntry("user_todo_edit", { phases });
	};
	cfgAsyncEnabled.override(fixture.settings, detached);
	cfgTaskEnableLsp.override(fixture.settings, false);
	cfgTaskPrewalk.override(fixture.settings, false);
	fixture.tracker.commit([
		{
			name: "Build",
			tasks: [
				{
					content: "Build adapter",
					status: "in_progress",
					details: "Keep the public API.",
					notes: ["Use the existing mapper."],
				},
				{ content: "Wait for upstream", status: "blocked", blocker: "waits on external-1" },
				{ content: "Document adapter", status: "pending" },
			],
		},
	]);
	await fixture.tracker.flush();
	const id = fixture.tracker.phases[0]!.tasks[0]!.id!;
	if (detached) {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		fixture.session.asyncJobManager = manager;
		cleanup.push(async () => {
			await manager.dispose({ timeoutMs: 1000 });
		});
	}
	return { ...fixture, id };
}

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	AsyncJobManager.resetForTests();
	vi.spyOn(discovery, "discoverAgents").mockResolvedValue({ agents: [agent], projectAgentsDir: null });
});

afterEach(async () => {
	await AgentLifecycleManager.global().dispose();
	for (const dispose of cleanup.splice(0).reverse()) await dispose();
	vi.restoreAllMocks();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	AsyncJobManager.resetForTests();
	unregisterCustomApis(SOURCE);
	AgentStorage.close();
	closeModelCache();
});

describe("todo task links", () => {
	it("link survives every static and dynamic item/flat schema", () => {
		const item = { task: "Build adapter", solutionSpace: "one specified change", todo: "repo-abc123.1" };
		for (const schema of [taskItemSchema, taskSchema]) expect(schema(item)).toMatchObject({ todo: item.todo });
		for (const batchEnabled of [false, true]) {
			for (const isolationEnabled of [false, true]) {
				for (const dynamic of [false, true]) {
					const schema = getTaskSchema({ batchEnabled, isolationEnabled, effortEnabled: dynamic });
					const parsed = schema(batchEnabled ? { context: "shared", tasks: [item] } : item);
					expect(parsed instanceof type.errors).toBe(false);
					expect(parsed).toMatchObject(batchEnabled ? { tasks: [{ todo: item.todo }] } : { todo: item.todo });
				}
			}
		}
	});

	for (const detached of [false, true]) {
		for (const batch of [false, true]) {
			it(`tick completes the linked ${batch ? "batch" : "flat"} item in a ${detached ? "detached" : "sync"} spawn`, async () => {
				const fixture = await parent(detached);
				cfgTaskBatch.override(fixture.settings, batch);
				const gate = Promise.withResolvers<void>();
				vi.spyOn(executor, "runSubprocess").mockImplementation(async options => {
					if (detached) await gate.promise;
					return result(options.id, { assignment: options.assignment });
				});
				const tool = await TaskTool.create(fixture.session);
				const item = {
					name: "Linked",
					task: "Build adapter",
					solutionSpace: "one specified change",
					todo: fixture.id,
				};
				const response = await tool.execute("linked", batch ? { context: "shared", tasks: [item] } : item);
				let output = text(response);
				if (detached) {
					expect(fixture.tracker.phases[0]!.tasks[0]!.status).toBe("in_progress");
					const job = fixture.session.asyncJobManager!.getJob(response.details!.async!.jobId)!;
					gate.resolve();
					await job.promise;
					output = job.resultText ?? "";
				} else expect(response.details!.results[0]!.todo).toBe(fixture.id);
				await fixture.tracker.flush();
				expect(output).toContain(`Todo ${fixture.id} marked done.`);
				expect(fixture.tracker.phases[0]!.tasks.map(task => task.status)).toEqual([
					"completed",
					"blocked",
					"in_progress",
				]);
				expect(fixture.remote.get(fixture.id)).toMatchObject({ status: "closed", close_reason: "done" });
				expect(getLatestTodoPhasesFromEntries(fixture.manager.getBranch())[0]!.tasks[0]!.status).toBe("completed");
			});
		}
	}

	for (const [label, failure] of [
		["nonzero exit", { exitCode: 1 }],
		["abort", { aborted: true }],
		["error", { error: "merge failed" }],
		["retry failure", { retryFailure: { attempt: 3, errorMessage: "rate limited" } }],
		["operator stop", { operatorStop: "scope changed" }],
	] satisfies Array<[string, Partial<SingleResult>]>) {
		it(`tick leaves the linked item unchanged after ${label}`, async () => {
			const fixture = await parent();
			const before = fixture.tracker.phases;
			vi.spyOn(executor, "runSubprocess").mockImplementation(async options => result(options.id, failure));
			const tool = await TaskTool.create(fixture.session);
			const response = await tool.execute("failure", { task: "Build adapter", todo: fixture.id });
			expect(response.details!.results[0]!.todo).toBe(fixture.id);
			expect(fixture.tracker.phases).toEqual(before);
			expect(text(response)).not.toContain("marked done.");
			expect(fixture.remote.get(fixture.id)!.status).toBe("in_progress");
		});
	}

	for (const nested of [false, true]) {
		it(`tick leaves the linked item open when the ${nested ? "nested patch apply" : "isolated merge"} fails`, async () => {
			const fixture = await parent();
			const before = fixture.tracker.phases;
			fixture.session.settings = fixture.settings.overlay({
				"task.isolation.enabled": true,
				"task.isolation.apply": true,
			});
			vi.spyOn(isolationRunner, "prepareIsolationContext").mockResolvedValue({ repoRoot: fixture.root });
			vi.spyOn(isolationRunner, "runIsolatedSubprocess").mockImplementation(async options =>
				result(options.agentId, {
					isolated: true,
					patchPath: `${options.artifactsDir}/${options.agentId}.patch`,
					...(nested
						? { nestedPatches: [{ relativePath: "nested", patch: "nested changes" }] }
						: {}),
				}),
			);
			vi.spyOn(isolationRunner, "mergeIsolatedChanges").mockResolvedValue({
				changesApplied: nested,
				summary: "",
				hadAnyChanges: true,
				mergedBranchForNestedPatches: false,
			});
			vi.spyOn(isolationRunner, "applyEligibleNestedPatches").mockResolvedValue(
				"\n\n<system-notification>Nested patch apply failed.</system-notification>",
			);
			const tool = await TaskTool.create(fixture.session);
			const response = await tool.execute("unapplied", { task: "Build adapter", todo: fixture.id, isolated: true });
			expect(response.details!.results[0]).toMatchObject({ todo: fixture.id, exitCode: 0 });
			expect(fixture.tracker.phases).toEqual(before);
			expect(fixture.remote.get(fixture.id)!.status).toBe("in_progress");
			expect(text(response)).not.toContain("marked done.");
		});
	}

	it("link resolves exact text or one unique match, but never an ambiguous or missing target", async () => {
		const fixture = await parent();
		let assignment = "";
		vi.spyOn(executor, "runSubprocess").mockImplementation(async options => {
			assignment = options.assignment ?? "";
			return result(options.id);
		});
		const tool = await TaskTool.create(fixture.session);
		for (const todo of ["Build adapter", undefined]) {
			fixture.tracker.setPhases([{ name: "Build", tasks: [{ content: "Build adapter", status: "pending" }] }]);
			const response = await tool.execute("match", {
				task: "  BUILD---adapter! \nReport the result.",
				...(todo ? { todo } : {}),
			});
			expect(assignment).toContain("<bead>");
			expect(response.details!.results[0]!.todo).toBe("Build adapter");
			expect(fixture.tracker.phases[0]!.tasks[0]!.status).toBe("completed");
		}
		fixture.tracker.setPhases([
			{ name: "One", tasks: [{ content: "Build adapter", status: "pending" }] },
			{ name: "Two", tasks: [{ content: "BUILD adapter!", status: "pending" }] },
		]);
		const before = fixture.tracker.phases;
		const ambiguous = await tool.execute("ambiguous", { task: "Build adapter\nReport the result." });
		expect(ambiguous.details!.results[0]!.todo).toBeUndefined();
		expect(fixture.tracker.phases).toEqual(before);
		const missing = await tool.execute("missing", { task: "Build adapter", todo: "missing-bead" });
		expect(missing.details!.results).toHaveLength(1);
		expect(missing.details!.results[0]!.todo).toBeUndefined();
		expect(text(missing)).toContain("Todo link missing-bead not found.");
		expect(fixture.tracker.phases).toEqual(before);
	});

	it("link ignores passing mentions, including a substring of the first line and a matching result label", async () => {
		const fixture = await parent();
		vi.spyOn(executor, "runSubprocess").mockImplementation(async options =>
			result(options.id, { description: "Build adapter" }),
		);
		const tool = await TaskTool.create(fixture.session);
		const before = fixture.tracker.phases;
		for (const task of [
			"Do not Build adapter; inspect dependencies instead.",
			"Inspect dependencies.\nBuild adapter belongs to another task.",
		]) {
			const response = await tool.execute("passing-mention", { task });
			expect(response.details!.results[0]!.todo).toBeUndefined();
			expect(fixture.tracker.phases).toEqual(before);
			expect(fixture.remote.get(fixture.id)!.status).toBe("in_progress");
			expect(text(response)).not.toContain("marked done.");
		}
	});

	it("an unresolved explicit link stays unlinked when its target appears during the run", async () => {
		const fixture = await parent();
		vi.spyOn(executor, "runSubprocess").mockImplementation(async options => {
			expect(options.assignment).not.toContain("<bead>");
			const phases = fixture.tracker.phases;
			phases[0]!.tasks.push({ content: "Late target", status: "pending" });
			fixture.tracker.setPhases(phases);
			return result(options.id, { description: "Late target" });
		});
		const tool = await TaskTool.create(fixture.session);
		const response = await tool.execute("late-link", { task: "Inspect dependencies", todo: "Late target" });
		expect(response.details!.results[0]!.todo).toBeUndefined();
		expect(text(response)).toContain("Todo link Late target not found.");
		expect(text(response)).not.toContain("marked done.");
		expect(fixture.tracker.phases[0]!.tasks.at(-1)!.status).toBe("pending");
	});

	for (const linked of [false, true]) {
		it(`speculation ${linked ? "defers first-line links until dispatch" : "can discard a finished unlinked run without ticking its result label"}`, async () => {
			const fixture = await parent();
			cfgTaskBatch.override(fixture.settings, true);
			const tool = await TaskTool.create(fixture.session);
			const coordinator: SpeculativeOperationSink = {
				maxInFlight: 1,
				admit: async () => undefined,
				authorizeLaunch: async () => ({ allowed: true }),
				close: () => {},
			};
			const toolCall: AgentToolCall = { type: "toolCall", id: "speculative-link", name: "task", arguments: {} };
			const stream = (await tool.speculation.stream!.open({
				coordinator,
				parentToolCallId: toolCall.id,
			})) as TaskLaunchSession;
			const task = linked ? "BUILD adapter!\nReport the result." : "Inspect dependencies.\nBuild adapter is separate.";
			let assignment = "";
			vi.spyOn(executor, "runSubprocess").mockImplementation(async options => {
				assignment = options.assignment ?? "";
				return result(options.id, { description: "Build adapter" });
			});
			const args = { context: "shared", tasks: [{ name: "Speculative", task }] };
			stream.update(toolCall, JSON.stringify(args));
			const runs = await stream.adopt([{ name: "Speculative", agent: "task", task, context: "shared" }]);
			if (linked) {
				expect(runs.size).toBe(0);
				expect(fixture.tracker.phases[0]!.tasks[0]!.status).toBe("in_progress");
				const response = await tool.execute(toolCall.id, args);
				expect(assignment).toContain("<bead>");
				expect(response.details!.results[0]!.todo).toBe(fixture.id);
				expect(fixture.tracker.phases[0]!.tasks[0]!.status).toBe("completed");
			} else {
				const run = runs.get(0)!;
				const response = await run.result;
				run.discard("Finished call rejected without dispatch");
				expect(response.details!.results[0]!.todo).toBeUndefined();
				expect(text(response)).not.toContain("marked done.");
				expect(fixture.tracker.phases[0]!.tasks[0]!.status).toBe("in_progress");
				expect(fixture.remote.get(fixture.id)!.status).toBe("in_progress");
			}
		});
	}

	it("link stays on its bead after a rename and repeated results do not reopen closed items", async () => {
		const fixture = await parent();
		const gate = Promise.withResolvers<void>();
		const started = Promise.withResolvers<void>();
		vi.spyOn(executor, "runSubprocess").mockImplementation(async options => {
			started.resolve();
			await gate.promise;
			return result(options.id);
		});
		const tool = await TaskTool.create(fixture.session);
		const running = tool.execute("rename", { task: "Build adapter", todo: fixture.id });
		await started.promise;
		const renamed = fixture.tracker.phases;
		renamed[0]!.tasks[0]!.content = "Build renamed adapter";
		renamed[0]!.tasks.push({ content: "Build adapter", status: "pending" });
		fixture.tracker.commit(renamed);
		gate.resolve();
		await running;
		await fixture.tracker.flush();
		expect(fixture.tracker.phases[0]!.tasks[0]!.status).toBe("completed");
		expect(fixture.tracker.phases[0]!.tasks[3]!.status).toBe("pending");
		const completed = fixture.tracker.phases;
		const again = await tool.execute("again", { task: "Build adapter", todo: fixture.id });
		expect(text(again)).not.toContain("marked done.");
		expect(fixture.tracker.phases).toEqual(completed);
	});

	it("subagent assignment holds read-only bead context and nested ticks affect only its scratch list", async () => {
		const fixture = await parent();
		const nestedStore = openTodoStore({
			cwd: fixture.root,
			settings: fixture.settings,
			agentKind: "sub",
			runner: fixture.runner,
			notice: () => {},
		});
		const scratch = new TodoTracker({ ...fixture.host, agentKind: () => "sub" }, nestedStore);
		scratch.setPhases([{ name: "Scratch", tasks: [{ content: "Build adapter", status: "pending" }] }]);
		const child = {
			...fixture.session,
			taskDepth: 1,
			getTodoPhases: () => scratch.phases,
			setTodoPhases: (phases: TodoPhase[]) => scratch.commit(phases),
			persistTodoPhases: () => {},
		};
		cfgTaskMaxRecursionDepth.override(fixture.settings, 4);
		let assignment = "";
		vi.spyOn(executor, "runSubprocess").mockImplementation(async options => {
			if (options.id === "Linked") {
				assignment = options.assignment ?? "";
				const nested = await TaskTool.create(child);
				await nested.execute("nested", { name: "Nested", task: "Build adapter", todo: "Build adapter" });
				expect(scratch.phases[0]!.tasks[0]!.status).toBe("completed");
				expect(fixture.tracker.phases[0]!.tasks[0]!.status).toBe("in_progress");
			}
			return result(options.id);
		});
		const tool = await TaskTool.create(fixture.session);
		await tool.execute("linked-context", { name: "Linked", task: "Build adapter", todo: fixture.id });
		for (const value of [
			"<bead>",
			fixture.id,
			"Build adapter",
			"in_progress",
			"Build",
			"Keep the public API.",
			"Use the existing mapper.",
			"Only the main session",
			"</bead>",
		])
			expect(assignment).toContain(value);
		expect(nestedStore.info.state).toBe("off");
	});

	for (const budgetStop of [false, true]) {
		it(`subagent real session has no todo tool, an off store, and ${budgetStop ? "budget" : "operator"} stop retains its partial output without a tick`, async () => {
			registerMockApi(SOURCE);
			const fixture = await parent();
			const auth = createInMemoryAuthStorage();
			auth.keys.setRuntime("mock", "test-key");
			cleanup.push(async () => {
				auth.close();
			});
			const registry = new ModelRegistry(auth);
			const started = Promise.withResolvers<void>();
			let childTools: string[] = [];
			let childStore: string | undefined;
			let requests = 0;
			const model = createMockModel({
				handler: context => {
					if (!context.tools?.some(tool => tool.name === "yield")) return { content: ["Adapter"] };
					const request = ++requests;
					if (request === 1) {
						const session = AgentRegistry.global().get("Stopped")!.session!;
						childTools = session.getEnabledToolNames();
						childStore = session.getTodoStore().info.state;
						started.resolve();
					}
					if (budgetStop && request <= 2) return { content: ["Inspecting adapter."] };
					if (!budgetStop && request === 1) {
						return { content: ["Inspecting adapter."], delayMs: 10_000 };
					}
					return { content: [{ type: "toolCall", name: "yield", arguments: { data: "partial adapter summary" } }] };
				},
			});
			const available = registry.getAvailable.bind(registry);
			vi.spyOn(registry, "getAvailable").mockImplementation(kind => [model, ...available(kind)]);
			vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
				agents: [{ ...agent, tools: ["read", "todo"], model: ["mock/mock-model"] }],
				projectAgentsDir: null,
			});
			fixture.session.authStorage = auth;
			fixture.session.modelRegistry = registry;
			fixture.session.enableMCP = false;
			fixture.session.noContextFiles = true;
			fixture.session.rules = [];
			fixture.session.skills = [];
			fixture.session.settings = fixture.settings.overlay({
				"task.agentIdleTtlMs": 0,
				"task.softRequestBudget": budgetStop ? 1 : 0,
				"task.structured": true,
				"compaction.enabled": false,
				"retry.enabled": false,
				"todo.reminders": false,
				"advisor.enabled": false,
				modelRoles: { default: "mock/mock-model", tiny: "mock/mock-model" },
			});
			const tool = await TaskTool.create(fixture.session);
			const running = tool.execute("stopped", { name: "Stopped", task: "Build adapter", todo: fixture.id });
			await Promise.race([
				started.promise,
				running.then(response => {
					throw new Error(`Task settled before startup: ${text(response)}`);
				}),
			]);
			if (!budgetStop) expect(stopSubagent("Stopped", "scope changed")).toEqual({ ok: true });
			const response = await running;
			const stopped = response.details!.results[0]!;
			expect(childTools).not.toContain("todo");
			expect(childStore).toBe("off");
			expect(stopped.operatorStop).toBe(budgetStop ? undefined : "scope changed");
			expect(stopped.budgetStop).toBe(true);
			expect(stopped.exitCode).toBe(0);
			expect(stopped.aborted).toBe(false);
			if (!budgetStop) expect(stopped.output).toContain("Stopped by operator: scope changed\n\n");
			expect(text(response)).toContain(
				formatTaskResultSummary(stopped, { totalDurationMs: response.details!.totalDurationMs }),
			);
			expect(text(response)).toContain("partial adapter summary");
			expect(text(response)).not.toContain("marked done.");
			expect(fixture.tracker.phases[0]!.tasks[0]!.status).toBe("in_progress");
		}, 30_000);
	}
});
