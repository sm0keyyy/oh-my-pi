import { expect, test } from "bun:test";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { TempDir, isRecord } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { normalizeRunbook } from "../../src/runbook/entries";
import { runRunbook } from "../../src/runbook/registry";
import { createAgentSession } from "../../src/sdk";
import { AuthStorage } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";

test("SDK-created runbook owners retire old books and run after newSession", async () => {
	await using temp = await TempDir.create("runbook-sdk-");
	const auth = await AuthStorage.create(":memory:");
	const model = createMockModel({ handler: { content: ["Received"] } });
	const { session } = await createAgentSession({
		cwd: temp.path(),
		agentDir: temp.join("agent"),
		authStorage: auth,
		modelRegistry: new ModelRegistry(auth),
		model,
		getApiKey: () => "test-key",
		sessionManager: SessionManager.inMemory(temp.path()),
		settings: Settings.isolated({ "compaction.enabled": false, "memory.backend": "off", "secrets.enabled": false }),
		agentRegistry: new AgentRegistry(),
		agentId: "RunbookSdkTest",
		hasUI: true,
		tuiTranscript: true,
		toolNames: ["runbook"],
		restrictToolNames: true,
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
	});
	session.agent.streamFn = model.stream;
	async function publish(title: string) {
		const tool = session.getToolByName("runbook");
		if (!tool) throw new Error("SDK did not register runbook");
		const result = await tool.execute(title, { title, steps: [{ title, command: "echo SDK_CAPTURE" }] });
		if (!isRecord(result.details) || typeof result.details.runbookId !== "string")
			throw new Error("Runbook returned no id");
		const details = normalizeRunbook(result.details, result.details.runbookId);
		session.sessionManager.appendMessage({
			role: "toolResult",
			toolName: "runbook",
			toolCallId: title,
			content: result.content,
			details,
			isError: false,
			timestamp: Date.now(),
		});
		return details;
	}
	try {
		const old = await publish("Old");
		expect(await session.newSession()).toBe(true);
		expect(await runRunbook(old.runbookId, 1, "tui")).toEqual({ ok: false, reason: "unknown-runbook" });
		const current = await publish("New");
		expect((await runRunbook(current.runbookId, 1, "tui")).ok).toBe(true);
		await session.settleAsyncWork();
		expect(session.sessionManager.getEntries()).toContainEqual(
			expect.objectContaining({
				type: "custom",
				customType: "runbook-run",
				data: { runbookId: current.runbookId, steps: [{ n: 1, host: "mac", exitCode: 0, tail: "SDK_CAPTURE" }] },
			}),
		);
		expect(
			model.calls.some(call =>
				call.context.messages.some(message =>
					typeof message.content === "string"
						? message.content.includes("SDK_CAPTURE")
						: message.content.some(part => part.type === "text" && part.text.includes("SDK_CAPTURE")),
				),
			),
		).toBe(true);
	} finally {
		await session.dispose();
		auth.close();
	}
});
