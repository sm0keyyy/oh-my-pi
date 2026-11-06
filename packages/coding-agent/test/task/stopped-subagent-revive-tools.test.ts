import { afterEach, beforeEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, type MockHandler, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "../../src/async";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { IrcBus } from "../../src/irc/bus";
import { AgentLifecycleManager } from "../../src/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "../../src/registry/agent-registry";
import { createAgentSession } from "../../src/sdk";
import { AgentStorage } from "../../src/session/agent-storage";
import { SUBAGENT_WRAP_UP_MESSAGE_TYPE } from "../../src/session/messages";
import { SessionManager } from "../../src/session/session-manager";
import { runSubagentFollowUpTurn, runSubprocess } from "../../src/task/executor";
import { stopSubagent } from "../../src/task/run-controls";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage, createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const SOURCE = "test/stopped-subagent-revive-tools";
const ID = "StoppedReader";
const STOP_REASON = "STOP_SCOPE_MARKER";
const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;
let savedEnv: Record<string, string | undefined>;
let root: string;

function restoreEnv(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
		delete Bun.env[key];
	} else {
		process.env[key] = value;
		Bun.env[key] = value;
	}
}

beforeEach(async () => {
	savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-stop-revive-tools-"));
	const home = path.join(root, "home");
	await fs.mkdir(home, { recursive: true });
	restoreEnv("HOME", home);
	vi.spyOn(os, "homedir").mockReturnValue(home);
	setAgentDir(path.join(home, ".omp", "agent"));
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	AsyncJobManager.resetForTests();
	registerMockApi(SOURCE);
});

afterEach(async () => {
	await AgentLifecycleManager.global().dispose();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	AsyncJobManager.resetForTests();
	unregisterCustomApis(SOURCE);
	vi.restoreAllMocks();
	for (const key of ENV_KEYS) restoreEnv(key, savedEnv[key]);
	__resetDirsFromEnvForTests();
	AgentStorage.close();
	closeModelCache();
	await removeWithRetries(root);
});

it.each([false, true])(
	"restores normal tools and expires the stop directive on parent IRC revival (structured=%s)",
	async structured => {
		const cwd = path.join(root, "work");
		await Bun.write(path.join(cwd, "notes.txt"), "revived tool access\n");
		const authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("mock", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const started = Promise.withResolvers<void>();
		let request = 0;
		const model = createMockModel({
			handler: context => {
				request++;
				if (request === 1) {
					started.resolve();
					return { content: ["exploring"], delayMs: 10_000 };
				}
				if (request === 2) {
					return structured
						? { content: [{ type: "toolCall", name: "yield", arguments: { data: "partial summary" } }] }
						: { content: ["partial summary"] };
				}
				if (
					context.messages.some(
						message => message.role === "developer" && JSON.stringify(message).includes(STOP_REASON),
					)
				) {
					return { content: ["Tools remained disabled after the operator stop."] };
				}
				if (context.messages.at(-1)?.role === "toolResult") return { content: ["read completed"] };
				return { content: [{ type: "toolCall", name: "read", arguments: { path: "notes.txt" } }] };
			},
		});
		const available = modelRegistry.getAvailable.bind(modelRegistry);
		vi.spyOn(modelRegistry, "getAvailable").mockImplementation(kind => [model, ...available(kind)]);
		try {
			const running = runSubprocess({
				cwd,
				artifactsDir: path.join(root, "artifacts"),
				agent: { name: "task", description: "test", systemPrompt: "test", tools: ["read"], source: "bundled" },
				task: "inspect notes",
				index: 0,
				id: ID,
				parentAgentId: MAIN_AGENT_ID,
				structured,
				modelOverride: "mock/mock-model",
				authStorage,
				modelRegistry,
				settings: Settings.isolated({
					"task.agentIdleTtlMs": 0,
					"task.softRequestBudget": 0,
					"async.enabled": false,
					"compaction.enabled": false,
					"retry.enabled": false,
					"todo.enabled": false,
					"todo.reminders": false,
					"advisor.enabled": false,
					modelRoles: { default: "mock/mock-model" },
				}),
				enableLsp: false,
				enableMCP: false,
				enableIrc: true,
			});
			await started.promise;
			expect(stopSubagent(ID, STOP_REASON)).toEqual({ ok: true });
			const result = await running;
			expect(result.exitCode).toBe(0);
			expect(result.output).toContain("partial summary");
			const wrapup = model.calls[1]!;
			expect(wrapup.context.messages.some(message => JSON.stringify(message).includes(STOP_REASON))).toBe(true);
			if (!structured) expect(wrapup.options?.toolChoice).toBe("none");
			expect(
				AgentRegistry.global()
					.get(ID)!
					.session!.sessionManager.getBranch()
					.find(entry => entry.type === "custom_message" && entry.customType === SUBAGENT_WRAP_UP_MESSAGE_TYPE),
			).toMatchObject({ details: { structured, operatorStopReason: STOP_REASON } });

			let completedReads = 0;
			for (const park of [false, true]) {
				if (park) {
					await AgentLifecycleManager.global().park(ID);
					expect(AgentRegistry.global().get(ID)?.status).toBe("parked");
				}
				const before = model.calls.length;
				const receipt = await IrcBus.global().send({ from: MAIN_AGENT_ID, to: ID, body: "Read notes.txt now." });
				expect(receipt.outcome).toBe(park ? "revived" : "woken");
				const session = AgentRegistry.global().get(ID)!.session!;
				await session.waitForIdle();
				await session.waitForIrcReplies();
				const wake = model.calls[before]!;
				expect(wake.options?.toolChoice).toBeUndefined();
				expect(wake.context.tools?.map(tool => tool.name)).toContain("read");
				const readResult = session.messages.findLast(
					message => message.role === "toolResult" && message.toolName === "read",
				);
				expect(
					session.messages.filter(message => message.role === "toolResult" && message.toolName === "read"),
				).toHaveLength(++completedReads);
				expect(readResult).toMatchObject({ isError: false });
				expect(JSON.stringify(readResult)).toContain("revived tool access");
				// Historical reports remain, but the expired developer restriction must not replay as an active instruction.
				expect(
					wake.context.messages
						.filter(message => message.role === "developer")
						.some(message => JSON.stringify(message).includes(STOP_REASON)),
				).toBe(false);
			}
		} finally {
			authStorage.close();
		}
	},
	30_000,
);

async function reopenInterruptedWrapUp(structured: boolean, handler: MockHandler, retry = false) {
	const cwd = path.join(root, "crashed-work");
	await Bun.write(path.join(cwd, "notes.txt"), "revived tool access\n");
	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("anthropic", "test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled Anthropic test model");
	const sessionManager = SessionManager.inMemory(cwd);
	sessionManager.appendMessage({ role: "user", content: "inspect notes", timestamp: Date.now() });
	sessionManager.appendMessage({ ...createAssistantMessage(""), stopReason: "aborted" });
	sessionManager.appendCustomMessageEntry(
		SUBAGENT_WRAP_UP_MESSAGE_TYPE,
		`<system-reminder>${STOP_REASON}: report partial findings for this forced wrap-up only.</system-reminder>`,
		false,
		{ structured, operatorStopReason: STOP_REASON },
		"agent",
	);
	sessionManager.appendCustomMessageEntry("memory-recall", "memory side context", false);
	const mock = createMockModel({ handler });
	const { session } = await createAgentSession({
		cwd,
		agentDir: path.join(root, "agent"),
		model,
		modelRegistry,
		sessionManager,
		settings: Settings.isolated({
			"task.softRequestBudget": 0,
			"async.enabled": false,
			"compaction.enabled": false,
			"retry.enabled": retry,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 100,
			"retry.maxRetries": 2,
			"retry.modelFallback": false,
			"todo.enabled": false,
			"todo.reminders": false,
			"advisor.enabled": false,
		}),
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		enableIrc: true,
		skipPythonPreflight: true,
		requireYieldTool: structured,
		toolNames: structured ? ["yield"] : ["read"],
		taskDepth: 1,
		agentId: ID,
		parentAgentId: MAIN_AGENT_ID,
		parentTaskPrefix: ID,
	});
	session.agent.streamFn = mock.stream;
	AgentRegistry.global().register({
		id: ID,
		kind: "sub",
		displayName: ID,
		session,
		status: "idle",
		parentId: MAIN_AGENT_ID,
	});
	return { session, mock, authStorage };
}

it("restores a forced yield past memory context and preserves the operator stop result", async () => {
	const reopened = await reopenInterruptedWrapUp(true, {
		content: [{ type: "toolCall", name: "yield", arguments: { type: ["partial"], data: "restored partial report" } }],
	});
	try {
		const result = await runSubagentFollowUpTurn({
			id: ID,
			agent: { name: "task", description: "test", systemPrompt: "test", source: "bundled" },
			message: "restore interrupted wrap-up",
			restore: true,
			structured: true,
		});
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain(`Stopped by operator: ${STOP_REASON}`);
		expect(result.output).toContain("restored partial report");
		expect(reopened.session.messages.filter(message => message.role === "toolResult")).toEqual([
			expect.objectContaining({ isError: false }),
		]);
		expect(result.extractedToolData?.yield).toHaveLength(1);
		expect(reopened.mock.calls[0]?.options?.toolChoice).toEqual({ type: "tool", name: "yield" });
		expect(JSON.stringify(reopened.mock.calls[0]?.context.messages)).toContain(STOP_REASON);
		expect(JSON.stringify(reopened.mock.calls[0]?.context.messages)).toContain("memory side context");
	} finally {
		await reopened.session.dispose();
		reopened.authStorage.close();
	}
}, 30_000);

it("a parent IRC assignment supersedes a crashed wrap-up without inheriting its restriction", async () => {
	const reopened = await reopenInterruptedWrapUp(false, context => {
		if (
			context.messages.some(message => message.role === "developer" && JSON.stringify(message).includes(STOP_REASON))
		) {
			return { content: ["Tools remain disabled."] };
		}
		if (context.messages.at(-1)?.role === "toolResult") return { content: ["read completed"] };
		return { content: [{ type: "toolCall", name: "read", arguments: { path: "notes.txt" } }] };
	});
	try {
		const receipt = await IrcBus.global().send({
			from: MAIN_AGENT_ID,
			to: ID,
			body: "Read notes.txt as a new assignment.",
		});
		expect(receipt.outcome).toBe("woken");
		await reopened.session.waitForIdle();
		await reopened.session.waitForIrcReplies();
		expect(reopened.mock.calls[0]?.options?.toolChoice).toBeUndefined();
		const result = reopened.session.messages.findLast(
			message => message.role === "toolResult" && message.toolName === "read",
		);
		expect(result).toMatchObject({ isError: false });
		expect(JSON.stringify(result)).toContain("revived tool access");
		expect(JSON.stringify(reopened.mock.calls[0]?.context.messages)).toContain("memory side context");
	} finally {
		await reopened.session.dispose();
		reopened.authStorage.close();
	}
}, 30_000);

it("keeps a live forced wrap-up restricted through two automatic retries", async () => {
	const started = Promise.withResolvers<void>();
	let request = 0;
	const reopened = await reopenInterruptedWrapUp(
		true,
		() => {
			request++;
			if (request === 1) {
				started.resolve();
				return { content: ["exploring"], delayMs: 10_000 };
			}
			if (request <= 3) {
				return { stopReason: "error", errorMessage: "503 service unavailable: overloaded_error" };
			}
			if (request === 4) {
				return { content: [{ type: "toolCall", name: "yield", arguments: { data: "retry-safe partial report" } }] };
			}
			throw new Error("Unexpected provider request after forced report");
		},
		true,
	);
	try {
		AgentRegistry.global().setStatus(ID, "running");
		const running = runSubagentFollowUpTurn({
			id: ID,
			agent: { name: "task", description: "test", systemPrompt: "test", source: "bundled" },
			message: "inspect notes",
			structured: true,
		});
		await started.promise;
		expect(stopSubagent(ID, STOP_REASON)).toEqual({ ok: true });
		const result = await running;
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("retry-safe partial report");
		expect(result.output).toContain(`Stopped by operator: ${STOP_REASON}`);
		expect(reopened.mock.calls).toHaveLength(4);
		for (const call of reopened.mock.calls.slice(1)) {
			expect(call.options?.toolChoice).toEqual({ type: "tool", name: "yield" });
			expect(
				call.context.messages.some(
					message => message.role === "developer" && JSON.stringify(message).includes(STOP_REASON),
				),
			).toBe(true);
		}
		expect(
			reopened.session.messages.some(
				message => message.role === "custom" && message.customType === SUBAGENT_WRAP_UP_MESSAGE_TYPE,
			),
		).toBe(false);
	} finally {
		await reopened.session.dispose();
		reopened.authStorage.close();
	}
}, 30_000);
