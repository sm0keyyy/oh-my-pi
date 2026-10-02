import { describe, expect, it } from "bun:test";
import { calculateCost, getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

function contextFor(session: SessionManager) {
	return new ExtensionRunner([], {} as never, "/tmp", session, {} as never).createContext();
}

describe("ExtensionContext.appendModelUsage", () => {
	it("records priced off-transcript usage only in the owning session", () => {
		const first = SessionManager.inMemory();
		const second = SessionManager.inMemory();
		const model = getBundledModel("openrouter", "mistralai/codestral-embed-2505");
		expect(model).toBeDefined();
		const usage = {
			input: 1_000_000,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 1_000_000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		calculateCost(model!, usage);
		const id = contextFor(first).appendModelUsage({
			purpose: "codegraph-embedding",
			api: model!.api,
			provider: model!.provider,
			model: model!.id,
			usage,
			stopReason: "stop",
		});
		expect(first.getEntries().find(entry => entry.id === id)).toMatchObject({
			type: "model_usage",
			purpose: "codegraph-embedding",
			usage: { input: 1_000_000, cost: { total: 0.15 } },
		});
		expect(second.getEntries().filter(entry => entry.type === "model_usage")).toEqual([]);
	});

	it("does not write a saved context to a successor session", async () => {
		const session = SessionManager.inMemory();
		const context = contextFor(session);
		await session.newSession();
		const id = context.appendModelUsage({
			purpose: "codegraph-embedding",
			api: "openai-embeddings",
			provider: "openrouter",
			model: "mistralai/codestral-embed-2505",
			usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop",
		});
		expect(id).toBeUndefined();
		expect(session.getEntries().filter(entry => entry.type === "model_usage")).toEqual([]);
	});
});
