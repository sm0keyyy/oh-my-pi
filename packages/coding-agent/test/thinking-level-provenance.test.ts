import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { Effort } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import * as autoThinkingClassifier from "@oh-my-pi/pi-coding-agent/auto-thinking/classifier";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { ThinkingLevelChangeEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { AgentOutputManager } from "@oh-my-pi/pi-coding-agent/task/output-manager";
import { AUTO_THINKING } from "@oh-my-pi/pi-tui/thinking";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

describe("thinking level provenance", () => {
	let session: AgentSession | undefined;
	let authStorage: AuthStorage;
	let authRoot: string;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		authRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-thinking-provenance-auth-"));
		authStorage = await AuthStorage.create(path.join(authRoot, "auth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(authRoot, "models.yml"));
	});

	afterAll(async () => {
		authStorage.close();
		await removeWithRetries(authRoot);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (session) await session.dispose();
		session = undefined;
	});

	function createSession(): AgentSession {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Claude Sonnet model");
		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [], thinkingLevel: Effort.High },
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry,
		});
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		return session;
	}

	function levelEntries(s: AgentSession): ThinkingLevelChangeEntry[] {
		return s.sessionManager
			.getEntries()
			.filter((entry): entry is ThinkingLevelChangeEntry => entry.type === "thinking_level_change");
	}

	it("logs one classifier entry per auto turn with the answer, even when the level is unchanged", async () => {
		const s = createSession();
		vi.spyOn(autoThinkingClassifier, "classifyDifficulty").mockResolvedValue(Effort.Low);
		s.setThinkingLevel(AUTO_THINKING);
		const before = levelEntries(s).length;

		await s.prompt("rename this variable");
		await s.prompt("rename that variable too");

		const turns = levelEntries(s).slice(before);
		expect(turns).toHaveLength(2);
		for (const entry of turns) {
			expect(entry).toMatchObject({
				thinkingLevel: Effort.Low,
				configured: AUTO_THINKING,
				source: "classifier",
				classifierAnswer: Effort.Low,
			});
		}
	});

	it("logs fallback with reason error when the classifier throws", async () => {
		const s = createSession();
		vi.spyOn(autoThinkingClassifier, "classifyDifficulty").mockRejectedValue(new Error("judge down"));
		s.setThinkingLevel(AUTO_THINKING);

		await s.prompt("fix the bug");

		expect(levelEntries(s).at(-1)).toMatchObject({ source: "fallback", fallbackReason: "error" });
		expect(levelEntries(s).at(-1)?.classifierAnswer).toBeUndefined();
	});

	it("logs fallback with reason timeout when the classifier is aborted by the deadline", async () => {
		const s = createSession();
		vi.spyOn(autoThinkingClassifier, "classifyDifficulty").mockImplementation((_input, deps) => {
			const { promise, reject } = Promise.withResolvers<Effort | undefined>();
			deps.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			return promise;
		});
		s.setThinkingLevel(AUTO_THINKING);

		await s.prompt("fix the bug");

		expect(levelEntries(s).at(-1)).toMatchObject({ source: "fallback", fallbackReason: "timeout" });
	}, 10_000);

	it("logs fallback with reason no_answer when the classifier resolves nothing", async () => {
		const s = createSession();
		vi.spyOn(autoThinkingClassifier, "classifyDifficulty").mockResolvedValue(undefined);
		s.setThinkingLevel(AUTO_THINKING);

		await s.prompt("fix the bug");

		expect(levelEntries(s).at(-1)).toMatchObject({ source: "fallback", fallbackReason: "no_answer" });
	});

	it("logs ultrathink without calling the classifier", async () => {
		const s = createSession();
		const classifier = vi.spyOn(autoThinkingClassifier, "classifyDifficulty").mockResolvedValue(Effort.Low);
		s.setThinkingLevel(AUTO_THINKING);

		await s.prompt("ultrathink about this migration");

		expect(classifier).not.toHaveBeenCalled();
		expect(levelEntries(s).at(-1)).toMatchObject({ configured: AUTO_THINKING, source: "ultrathink" });
	});

	it("logs manual for a user selection and the caller's source otherwise", () => {
		const s = createSession();
		s.setThinkingLevel(Effort.Low);
		expect(levelEntries(s).at(-1)).toMatchObject({ thinkingLevel: Effort.Low, source: "manual" });

		s.setThinkingLevel(AUTO_THINKING);
		expect(levelEntries(s).at(-1)).toMatchObject({ configured: AUTO_THINKING, source: "manual" });

		s.setThinkingLevel(Effort.Medium, false, "extension");
		expect(levelEntries(s).at(-1)).toMatchObject({ thinkingLevel: Effort.Medium, source: "extension" });

		s.cycleThinkingLevel();
		expect(levelEntries(s).at(-1)?.source).toBe("manual");
	});
});

describe("subagent re-dispatch link", () => {
	it("links a repeated name to the id of its first run", async () => {
		const manager = new AgentOutputManager(() => null);
		const first = await manager.allocate("Scout");
		const second = await manager.allocate("Scout");
		const third = await manager.allocate("Scout");
		const other = await manager.allocate("Coder");

		expect(manager.firstRunOf(first)).toBeUndefined();
		expect(manager.firstRunOf(other)).toBeUndefined();
		expect(manager.firstRunOf(second)).toBe("Scout");
		expect(manager.firstRunOf(third)).toBe("Scout");
	});

	it("links nested ids under the parent prefix", async () => {
		const manager = new AgentOutputManager(() => null, { parentPrefix: "Lead" });
		await manager.allocate("Scout");
		const again = await manager.allocate("Scout");

		expect(again).toBe("Lead.Scout-2");
		expect(manager.firstRunOf(again)).toBe("Lead.Scout");
	});

	it("links a re-dispatch to a first run found on disk after resume", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-redispatch-"));
		try {
			await Bun.write(path.join(dir, "Scout.jsonl"), "");
			const manager = new AgentOutputManager(() => dir);
			const again = await manager.allocate("Scout");

			expect(again).toBe("Scout-2");
			expect(manager.firstRunOf(again)).toBe("Scout");
		} finally {
			await removeWithRetries(dir);
		}
	});
});
