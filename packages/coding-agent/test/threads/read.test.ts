import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import { readAgentThread } from "@oh-my-pi/pi-coding-agent/threads/index";
import { logger } from "@oh-my-pi/pi-utils";

const fixtures = `${import.meta.dir}/../fixtures/threads`;

afterEach(() => {
	vi.restoreAllMocks();
});

describe("thread files", () => {
	it("TM.b: keeps two revived runs in one thread and ignores unknown custom types", async () => {
		const file = `${fixtures}/revived.jsonl`;
		const thread = await readAgentThread("Alpha", file);
		expect(thread.agentId).toBe("Alpha");
		expect(thread.sessionFile).toBe(file);
		expect(thread.items.map(item => item.kind)).toEqual(["brief", "result", "operator", "reply", "result"]);
		expect(thread.items.filter(item => "text" in item).map(item => item.text)).toEqual([
			"First assignment.",
			"First result.",
			"Continue with the second run.",
			"Second reply.",
			"Second result.",
		]);
	});

	it("TM.b: a missing parent leaves all child items readable", async () => {
		const file = `${fixtures}/child.jsonl`;
		expect(await readAgentThread("Alpha", file, `${fixtures}/missing-parent.jsonl`)).toEqual(
			await readAgentThread("Alpha", file),
		);
		expect(await readAgentThread("Alpha", file, `${fixtures}/parent.jsonl`)).toEqual(
			await readAgentThread("Alpha", file),
		);
	});

	it("disables an unreadable thread with one warning instead of throwing into its caller", async () => {
		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		const file = `${fixtures}/missing-child.jsonl`;
		expect(await readAgentThread("Missing", file)).toEqual({ agentId: "Missing", sessionFile: file, items: [] });
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0]?.[0]).toStartWith("threads:");
	});
});
