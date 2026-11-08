import * as path from "node:path";
import { isRecord, TempDir } from "@oh-my-pi/pi-utils";
import type { Message } from "@oh-my-pi/pi-ai";
import { createAgentSession } from "../../coding-agent/src/sdk";
import { createRpcConnection, type RpcConnection } from "../../coding-agent/src/modes/rpc/rpc-mode";
import { Settings } from "../../coding-agent/src/config/settings";
import { normalizeRunbook } from "../../coding-agent/src/runbook/entries";
import { onUsageChange, startUsagePoller } from "../../coding-agent/src/usage";
import { EventBus } from "../../coding-agent/src/utils/event-bus";
import { fixture as runbookFixture } from "../../coding-agent/test/runbook/fixture";
import "../../coding-agent/src/usage/settings";

const root = path.resolve(import.meta.dir, "../../..");
await using temp = await TempDir.create("@j-sessions-browser-");
const { session } = await createAgentSession({
	cwd: temp.path(),
	agentDir: temp.join("agent"),
	toolNames: [],
	enableMCP: false,
	enableLsp: false,
	disableExtensionDiscovery: true,
	settings: Settings.isolated({ "compaction.enabled": false }),
});
const book = runbookFixture(undefined, session.sessionManager);
const details = normalizeRunbook(
	{
		title: "Browser runbook",
		steps: [
			{ title: "Print marker", command: "printf j-browser-run" },
			{ title: "Print final marker", command: "printf j-browser-all" },
		],
	},
	crypto.randomUUID(),
);
const messages: Message[] = [
	...Array.from({ length: 55 }, (_, index): Message => ({
		role: "user",
		content: `Earlier main transcript message ${index + 1}`,
		timestamp: index + 1,
	})),
	{
		role: "assistant",
		content: [{ type: "toolCall", id: "browser-book", name: "runbook", arguments: { ...details } }],
		api: "openai-completions",
		provider: "fixture",
		model: "fixture",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 56,
	},
	{
		role: "toolResult",
		toolCallId: "browser-book",
		toolName: "runbook",
		content: [{ type: "text", text: "Runbook shown; no command has run." }],
		details,
		isError: false,
		timestamp: 57,
	},
];
for (const message of messages) {
	session.sessionManager.appendMessage(message);
	session.agent.appendMessage(message);
}
book.owner.add(details);
const usageReady = Promise.withResolvers<void>();
const unsubscribe = onUsageChange(() => usageReady.resolve());
const usage = startUsagePoller({
	settings: session.settings,
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
								identity: { plan: "Pro", email: "fixture@example.invalid" },
								windows: [
									{ kind: "session", label: "Session", usedPercent: 42, resetAt: "2026-11-08T00:00:00Z" },
								],
							},
						],
					})
				: "[]",
		};
	},
});
await usageReady.promise;
const instanceId = "0123456789abcdef";
const connections = new Map<
	string,
	{ connection: RpcConnection; input: ReadableStreamDefaultController<Uint8Array> }
>();
const commands: Record<string, unknown>[] = [];
const responses: Record<string, unknown>[] = [];
const sessionFile = path.join(root, "packages/coding-agent/test/fixtures/threads/revived.jsonl");
const startedAt = Date.now();
const shutdown = Promise.withResolvers<void>();
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	idleTimeout: 0,
	async fetch(request) {
		const url = new URL(request.url);
		const client = url.searchParams.get("client") ?? "";
		if (url.pathname === "/fixture/receipts")
			return Response.json({ commands, responses, deliveries: book.deliveries });
		if (url.pathname === "/fixture/shutdown") {
			shutdown.resolve();
			return new Response("closing");
		}
		if (url.pathname.startsWith("/events/session/")) {
			let sequence = 0;
			let closed = false;
			const stream = new ReadableStream<Uint8Array>({
				async start(controller) {
					let input!: ReadableStreamDefaultController<Uint8Array>;
					const connection = await createRpcConnection({
						session,
						subagentEventBus: new EventBus(),
						host: {
							subagents: () => [
								{
									id: "Worker",
									index: 0,
									agent: "task",
									agentSource: "bundled",
									status: "completed",
									sessionFile,
									lastUpdate: startedAt,
								},
							],
						},
						input: new ReadableStream({
							start(controller) {
								input = controller;
							},
						}),
						writer: {
							write(lines) {
								for (const line of lines) {
									if (!line || closed) continue;
									const value: unknown = JSON.parse(line);
									if (isRecord(value) && value.type === "response") responses.push(value);
									controller.enqueue(new TextEncoder().encode(`id: j:${++sequence}\ndata: ${line}\n\n`));
								}
							},
						},
					});
					connections.set(client, { connection, input });
				},
				async cancel() {
					closed = true;
					const current = connections.get(client);
					if (!current) return;
					connections.delete(client);
					current.input.close();
					await current.connection.done;
					await current.connection.dispose();
				},
			});
			return new Response(stream, { headers: { "content-type": "text/event-stream" } });
		}
		if (url.pathname.startsWith("/api/session/")) {
			if (request.method === "DELETE") return new Response(null, { status: 204 });
			const body: unknown = await request.json();
			if (
				!isRecord(body) ||
				typeof body.client !== "string" ||
				typeof body.line !== "string" ||
				!Number.isSafeInteger(body.sequence)
			)
				return new Response("Invalid envelope", { status: 400 });
			const current = connections.get(body.client);
			if (!current) return new Response("Not attached", { status: 409 });
			const command: unknown = JSON.parse(body.line);
			if (isRecord(command)) commands.push(command);
			current.input.enqueue(new TextEncoder().encode(body.line + "\n"));
			return Response.json({ ack: body.sequence });
		}
		if (url.pathname === "/api/sessions")
			return Response.json({
				sessions: [
					{
						instanceId,
						pid: process.pid,
						sessionId: session.sessionId,
						cwd: temp.path(),
						busy: false,
						inputRequired: false,
						startedAt,
						lastActivity: startedAt,
					},
				],
			});
		const file = Bun.file(path.join(root, "packages/sessions-web/dist", path.basename(url.pathname)));
		return new Response(
			(await file.exists()) ? file : Bun.file(path.join(root, "packages/sessions-web/dist/index.html")),
		);
	},
});
console.log(`READY http://127.0.0.1:${server.port}`);
try {
	await shutdown.promise;
} finally {
	for (const current of connections.values()) {
		current.input.close();
		await current.connection.done;
		await current.connection.dispose();
	}
	connections.clear();
	server.stop(false);
	usage.dispose();
	unsubscribe();
	await book.close();
	await session.dispose();
}
