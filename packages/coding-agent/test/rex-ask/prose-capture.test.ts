import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { logger, untilAborted } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import * as asks from "../../src/rex-ask";
import { captureProseAsk } from "../../src/rex-ask/prose-capture";
import { rexAskSettings } from "../../src/rex-ask/settings";
import { AgentSession } from "../../src/session/agent-session";
import type { AuthStorage } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";
import { createAssistantMessage, createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { asGlobalFetch } from "../helpers/fetch-mock";

const jev = {
	id: "jev-preview",
	name: "Jev",
	api: "typesafe",
	provider: "typesafe",
	baseUrl: "https://judge.example.test/",
	kind: "judge",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 4096,
} as Model<Api>;

const question = "Want me to draft the WATCHDOG.md?";

describe("prose questions become operator asks", () => {
	let auth: AuthStorage;
	let registry: ModelRegistry;
	let settings: Settings;
	let session: AgentSession | undefined;
	let probability: number;
	let fail: boolean;
	let judged: string[];
	let filed: Parameters<typeof asks.requestOperatorAsk>[0][];
	let replies: string[];

	beforeEach(() => {
		auth = createInMemoryAuthStorage();
		auth.keys.setRuntime("typesafe", "test-key");
		auth.keys.setRuntime("anthropic", "test-key");
		registry = new ModelRegistry(auth, "/nonexistent/prose-capture-models.yml");
		vi.spyOn(registry, "getAvailable").mockReturnValue([jev]);
		settings = Settings.isolated({
			"compaction.enabled": false,
			"todo.enabled": false,
			modelRoles: { judge: "typesafe/jev-preview" },
		});
		probability = 0.9;
		fail = false;
		judged = [];
		filed = [];
		replies = [];
		vi.spyOn(asks, "askHostSessionId").mockReturnValue("test-prose-capture");
		vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(async (_url, init) => {
				const body = JSON.parse(String(init?.body));
				judged.push(body.state.message);
				if (fail) throw new Error("Jev offline");
				return Response.json({
					answers: { asks: { type: "noul", noul: probability } },
					usage: { input_tokens: 10, output_tokens: 1 },
				});
			}),
		);
		vi.spyOn(asks, "requestOperatorAsk").mockImplementation(async req => {
			filed.push(req);
			return { answer: "/quit" };
		});
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		auth.close();
		vi.restoreAllMocks();
	});

	function deps() {
		return {
			settings,
			registry,
			sessionId: "test-prose-capture",
			agentKind: "main" as const,
			source: { agent: "Main", role: "coder", sessionId: "test-prose-capture", sessionLabel: "Watchdog" },
			isCurrent: () => true,
			prompt: async (answer: string) => {
				replies.push(answer);
				return true;
			},
		};
	}

	function mainSession(): AgentSession {
		const agent = new Agent({
			initialState: {
				model: getBundledModel("anthropic", "claude-sonnet-4-5"),
				tools: [],
				messages: [],
				systemPrompt: ["Test"],
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory("/tmp/prose-capture"),
			settings,
			modelRegistry: registry,
		});
		vi.spyOn(asks, "askHostSessionId").mockReturnValue(session.sessionId);
		return session;
	}

	it("captures the main final paragraph and delivers /quit as literal user text", async () => {
		const live = mainSession();
		const agent = live.agent;
		const delivered = Promise.withResolvers<void>();
		const prompt = vi.spyOn(agent, "prompt").mockImplementation(async () => delivered.resolve());
		const message = createAssistantMessage(`The watchdog is configured.\n\n${question}`);
		agent.emitExternalEvent({ type: "message_end", message });
		agent.emitExternalEvent({ type: "agent_end", messages: [message] });
		await untilAborted(AbortSignal.timeout(4_000), delivered.promise);
		await live.waitForIdle();
		expect(judged).toEqual([message.content[0].type === "text" ? message.content[0].text : ""]);
		expect(filed).toEqual([
			{
				question,
				context: "The watchdog is configured.",
				source: { agent: "Main", role: "main", sessionId: live.sessionId, sessionLabel: undefined },
				allowFreeText: true,
				signal: expect.any(AbortSignal),
			},
		]);
		const dispatched: unknown = prompt.mock.calls[0][0];
		expect(dispatched).toEqual([
			expect.objectContaining({ role: "user", content: [{ type: "text", text: "/quit" }] }),
		]);
		agent.state.isStreaming = true;
		try {
			await captureProseAsk(`${question} (busy)`, {
				...deps(),
				sessionId: live.sessionId,
				prompt: (answer, options) => live.prompt(answer, options),
			});
			expect(live.getQueuedMessages()).toMatchObject({ followUp: ["/quit"], steering: [] });
		} finally {
			agent.state.isStreaming = false;
		}
	});

	it("does not send a non-match to Jev and files nothing when Jev says no", async () => {
		await captureProseAsk("Good night.", deps());
		expect(judged).toEqual([]);
		probability = 0;
		await captureProseAsk(question, deps());
		expect(judged).toEqual([question]);
		expect(filed).toEqual([]);
		expect(replies).toEqual([]);
	});

	it("never captures subagents or when the setting is off", async () => {
		await captureProseAsk(question, { ...deps(), agentKind: "sub" });
		rexAskSettings.proseCapture.override(settings, false);
		await captureProseAsk(question, deps());
		expect(judged).toEqual([]);
		expect(filed).toEqual([]);
	});

	it("does not capture a helper session even when its agentKind is main", async () => {
		await captureProseAsk(question, { ...deps(), sessionId: "helper-session" });
		expect(judged).toEqual([]);
		expect(filed).toEqual([]);
	});

	it("does not call Jev without an ask-pane host", async () => {
		vi.spyOn(asks, "askHostSessionId").mockReturnValue(undefined);
		await captureProseAsk(question, deps());
		expect(judged).toEqual([]);
		expect(filed).toEqual([]);
	});

	for (const action of ["abort", "chat"] as const) {
		it(`${action} withdraws a pending capture and rejects its late answer`, async () => {
			const live = mainSession();
			const asked = Promise.withResolvers<Parameters<typeof asks.requestOperatorAsk>[0]>();
			const answer = Promise.withResolvers<asks.OperatorAskAnswer>();
			vi.spyOn(asks, "requestOperatorAsk").mockImplementation(req => {
				asked.resolve(req);
				return answer.promise;
			});
			const prompt = vi.spyOn(live.agent, "prompt").mockResolvedValue();
			const message = createAssistantMessage(`${question} (${action})`);
			live.agent.emitExternalEvent({ type: "message_end", message });
			live.agent.emitExternalEvent({ type: "agent_end", messages: [message] });
			const pending = await untilAborted(AbortSignal.timeout(4_000), asked.promise);
			if (action === "abort") await live.abort();
			else await live.prompt("Do it.");
			expect(pending.signal?.aborted).toBe(true);
			answer.resolve({ answer: "Stale float answer" });
			await live.waitForIdle();
			const dispatched: unknown = prompt.mock.calls.map(([messages]) => messages);
			expect(dispatched).toEqual(
				action === "abort"
					? []
					: [[expect.objectContaining({ role: "user", content: [{ type: "text", text: "Do it." }] })]],
			);
		});
	}

	it("logs one capture failure and files nothing when Jev fails", async () => {
		fail = true;
		const log = vi.spyOn(logger, "warn").mockImplementation(() => {});
		await captureProseAsk(`${question} (offline test)`, deps());
		expect(filed).toEqual([]);
		expect(replies).toEqual([]);
		expect(log.mock.calls.filter(([message]) => message === "prose-capture: capture failed")).toHaveLength(1);
	}, 15_000);

	it("matches a last-paragraph question without a keyword and caps question and context", async () => {
		await captureProseAsk(`${"x".repeat(700)}\r\n\r\n${"y".repeat(510)}?`, deps());
		expect(filed[0]).toMatchObject({ question: "y".repeat(500), context: "x".repeat(600), source: deps().source });
		expect(replies).toEqual(["/quit"]);
	});

	it("does not treat a question mark in an earlier paragraph as a regex hit", async () => {
		await captureProseAsk("The output was `ready?`.\n\nGood night.", deps());
		expect(judged).toEqual([]);
		expect(filed).toEqual([]);
	});

	it("does not deliver a cancelled ask or an answer after the session changed", async () => {
		vi.spyOn(asks, "requestOperatorAsk").mockResolvedValueOnce({ cancelled: true });
		await captureProseAsk(`${question} (cancelled)`, deps());
		let current = true;
		vi.spyOn(asks, "requestOperatorAsk").mockImplementationOnce(async () => {
			current = false;
			return { answer: "/quit" };
		});
		await captureProseAsk(`${question} (old session)`, { ...deps(), isCurrent: () => current });
		expect(replies).toEqual([]);
	});
});
