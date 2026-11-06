import { afterEach, beforeEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { AsyncJobManager } from "../../src/async";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { IrcBus } from "../../src/irc/bus";
import { AgentLifecycleManager } from "../../src/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "../../src/registry/agent-registry";
import { AgentStorage } from "../../src/session/agent-storage";
import { runSubprocess } from "../../src/task/executor";
import { stopSubagent } from "../../src/task/run-controls";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

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
