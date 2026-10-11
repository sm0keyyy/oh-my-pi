import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { startBridge } from "../../sessions-bridge/src/bridge";
import { PUBLIC_ORIGIN } from "../../sessions-gateway/src/protocol";
import { startGateway } from "../../sessions-gateway/src/server";
import { createAccessFixture } from "../../sessions-gateway/test/access-fixture";

const root = path.resolve(import.meta.dir, "../../..");
const config = path.join(root, ".sessions-d-test-config");
await fs.mkdir(config, { recursive: false, mode: 0o700 });
const evidence = path.join(root, "packages/sessions-web/evidence");
await fs.mkdir(path.join(evidence, "screenshots"), { recursive: true });
const agentDir = path.join(config, "agent");
await fs.mkdir(agentDir, { mode: 0o700 });
await Bun.write(
	path.join(agentDir, "config.yml"),
	"compaction:\n  keepRecentTokens: 1\n  methodOrder: [soft]\nspelling:\n  autocomplete: off\n",
);
const owned = new Map<string, Bun.Subprocess>();
const sockets = new Set<Bun.ServerWebSocket<{ upstream: WebSocket; queued: string[] }>>();
const receipts: unknown[] = [];
const provider = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const url = new URL(request.url);
		if (url.pathname.endsWith("/models"))
			return Response.json({ object: "list", data: [{ id: "gpt-4.1" }, { id: "gpt-4.1-2" }] });
		if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
		const body = (await request.json()) as {
			messages: Array<{ role: string; content: unknown }>;
			tools?: Array<{ function: { name: string } }>;
			stream?: boolean;
		};
		const last = body.messages.at(-1);
		const content =
			typeof last?.content === "string"
				? last.content
				: Array.isArray(last?.content)
					? last.content.map(part => part.text ?? "").join("")
					: "";
		const slow = content.includes("[slow]");
		const tools = body.tools?.map(tool => tool.function.name) ?? [];
		const tool =
			last?.role === "user" && content.includes("[tool]") && tools.includes("read")
				? { name: "read", args: { path: path.join(config, "sample.txt") } }
				: last?.role === "user" && content.includes("[agent]") && tools.includes("task")
					? {
							name: "task",
							args: {
								name: "BrowserAgent",
								agent: "task",
								task: "[slow] Local browser acceptance. Reply with local text.",
								solutionSpace: "Only the local fixture.",
								model: "fake/gpt-4.1",
								tools: [],
							},
						}
					: undefined;
		const reply = tool
			? {
					role: "assistant",
					content: null,
					tool_calls: [
						{
							id: `call_${crypto.randomUUID()}`,
							type: "function",
							function: { name: tool.name, arguments: JSON.stringify(tool.args) },
						},
					],
				}
			: {
					role: "assistant",
					content:
						last?.role === "tool" ? `Tool result received: ${content}` : `Local answer: ${content || "summary"}`,
				};
		const usage = { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 };
		if (!body.stream)
			return Response.json({
				id: "fixture",
				object: "chat.completion",
				created: 0,
				model: "gpt-4.1",
				choices: [{ index: 0, message: reply, finish_reason: tool ? "tool_calls" : "stop" }],
				usage,
			});
		const base = { id: "fixture", object: "chat.completion.chunk", created: 0, model: "gpt-4.1" };
		const encoder = new TextEncoder();
		const stream = new ReadableStream({
			async start(controller) {
				const emit = (delta: unknown, finish_reason: string | null = null) =>
					controller.enqueue(
						encoder.encode(
							`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
						),
					);
				try {
					if (tool)
						emit({ role: "assistant", tool_calls: reply.tool_calls?.map((call, index) => ({ ...call, index })) });
					else {
						emit({ role: "assistant", reasoning_content: "This is a local scripted provider." });
						for (let i = 0; i < (slow ? 60 : 1); i++) {
							if (request.signal.aborted) break;
							emit({ content: slow ? `stream-${i} ` : reply.content });
							if (slow) await Bun.sleep(1000);
						}
					}
					emit({}, tool ? "tool_calls" : "stop");
					controller.enqueue(
						encoder.encode(`data: ${JSON.stringify({ ...base, choices: [], usage })}\n\ndata: [DONE]\n\n`),
					);
					controller.close();
				} catch (error) {
					if (!request.signal.aborted) controller.error(error);
				}
			},
			cancel() {},
		});
		return new Response(stream, { headers: { "content-type": "text/event-stream" } });
	},
});
await Bun.write(path.join(config, "sample.txt"), "Local tool-render acceptance.\n");
await Bun.write(
	path.join(config, "sample.png"),
	Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6X2QAAAAASUVORK5CYII=",
		"base64",
	),
);
await Bun.write(
	path.join(agentDir, "models.yml"),
	`providers:\n  fake:\n    baseUrl: http://127.0.0.1:${provider.port}/v1\n    auth: none\n    api: openai-completions\n    models:\n      - id: gpt-4.1\n        name: Local Model\n        reasoning: true\n        input: [text, image]\n        contextWindow: 128000\n        maxTokens: 8192\n      - id: gpt-4.1-2\n        name: Local Model Two\n        reasoning: true\n        input: [text, image]\n        contextWindow: 128000\n        maxTokens: 8192\n`,
);
const access = await createAccessFixture();
const token = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
const gateway = await startGateway({
	token,
	siteDir: path.join(root, "packages/sessions-web/dist"),
	hostname: "127.0.0.1",
	port: 0,
	accessCertsUrl: access.certsUrl,
});
const bridge = startBridge({
	url: gateway.url.replace("http:", "ws:") + "/ws/bridge",
	headers: { ...access.headers, authorization: `Bearer ${token}` },
	dir: path.join(config, "run/rpc-sessions"),
	heartbeatMs: 1000,
});
const proxy = Bun.serve<{ upstream: WebSocket; queued: string[] }>({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request, server) {
		const url = new URL(request.url);
		if (url.pathname === "/fixture/receipts") return Response.json(receipts);
		if (url.pathname === "/fixture/shutdown") {
			setTimeout(() => void stop().then(() => process.exit(0)), 100);
			return Response.json({ stopping: true });
		}
		if (url.pathname === "/fixture/start") {
			const name = url.searchParams.get("name") ?? "desktop";
			if (!/^(desktop|phone|lobby-desktop|lobby-phone)$/.test(name) || owned.has(name))
				return new Response("invalid or already running", { status: 409 });
			const cwd = path.join(config, "workspaces", name);
			await fs.mkdir(cwd, { recursive: true });
			const writer = Bun.file(path.join(evidence, `${name}-tui.log`)).writer();
			const child = Bun.spawn(
				[
					process.execPath,
					path.join(root, "packages/coding-agent/src/cli.ts"),
					"--model",
					"fake/gpt-4.1",
					"--no-skills",
					"--no-rules",
					"--no-title",
					"--no-lsp",
					"--no-extensions",
					"--extension",
					path.join(import.meta.dir, "fixture-extension.ts"),
				],
				{
					cwd,
					env: {
						PATH: process.env.PATH,
						HOME: os.homedir(),
						TMPDIR: process.env.TMPDIR,
						LANG: "en_US.UTF-8",
						PI_CONFIG_DIR: path.relative(os.homedir(), config),
						PI_CODING_AGENT_DIR: agentDir,
						PI_NO_TITLE: "1",
						TERM: "xterm-256color",
						COLORTERM: "truecolor",
					},
					terminal: {
						cols: 120,
						rows: 40,
						data(terminal, data) {
							writer.write(data);
							if (new TextDecoder().decode(data).includes("\x1b[6n")) terminal.write("\x1b[40;1R");
						},
					},
				},
			);
			owned.set(name, child);
			void child.exited.then(async code => {
				await writer.end();
				owned.delete(name);
				receipts.push({ event: "tui_exit", name, code, at: Date.now() });
			});
			receipts.push({ event: "tui_start", name, pid: child.pid, at: Date.now() });
			return Response.json({ name, pid: child.pid, cwd });
		}
		if (url.pathname === "/fixture/stop") {
			const name = url.searchParams.get("name") ?? "desktop";
			const child = owned.get(name);
			if (!child) return new Response("not running", { status: 404 });
			child.kill("SIGINT");
			await Promise.race([child.exited, Bun.sleep(10000)]);
			if (child.exitCode === null) {
				child.kill("SIGKILL");
				await child.exited;
			}
			return Response.json({ stopped: name });
		}
		if (url.pathname === "/fixture/drop") {
			const ms = Number(url.searchParams.get("ms") ?? "5000");
			if (!Number.isFinite(ms) || ms < 1000 || ms > 20000) return new Response("invalid duration", { status: 400 });
			for (const socket of sockets) {
				socket.data.upstream.close();
				socket.close(4001, "simulated connection drop");
			}
			droppingUntil = Date.now() + ms;
			receipts.push({ event: "network_drop", at: Date.now(), ms });
			return Response.json({ ms });
		}
		if (url.pathname.startsWith("/ws/session/")) {
			if (Date.now() < droppingUntil) return new Response("simulated network drop", { status: 503 });
			const upstream = new WebSocket(gateway.url.replace("http:", "ws:") + url.pathname, {
				headers: { ...access.headers, origin: PUBLIC_ORIGIN },
			});
			if (server.upgrade(request, { data: { upstream, queued: [] } })) return;
			upstream.close();
			return new Response("upgrade required", { status: 400 });
		}
		return access.fetch(gateway.url + url.pathname + url.search, {
			method: request.method,
			body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
		});
	},
	websocket: {
		open(socket) {
			sockets.add(socket);
			const upstream = socket.data.upstream;
			upstream.onopen = () => {
				for (const line of socket.data.queued) upstream.send(line);
				socket.data.queued = [];
			};
			upstream.onmessage = event => {
				if (typeof event.data !== "string") return;
				const frame = JSON.parse(event.data);
				if (frame.type === "response") receipts.push({ direction: "response", frame, at: Date.now() });
				socket.send(event.data);
			};
			upstream.onclose = () => socket.close(4001, "gateway closed");
			upstream.onerror = () => socket.close(1011, "gateway error");
		},
		message(socket, message) {
			if (typeof message !== "string") return socket.close(1003, "text required");
			receipts.push({ direction: "command", frame: JSON.parse(message), at: Date.now() });
			if (socket.data.upstream.readyState === WebSocket.OPEN) socket.data.upstream.send(message);
			else socket.data.queued.push(message);
		},
		close(socket) {
			sockets.delete(socket);
			socket.data.upstream.close();
		},
	},
});
let droppingUntil = 0;
let stopped = false;
const stop = async () => {
	if (stopped) return;
	stopped = true;
	for (const child of owned.values()) child.kill("SIGINT");
	await Promise.all(
		[...owned.values()].map(async child => {
			await Promise.race([child.exited, Bun.sleep(10000)]);
			if (child.exitCode === null) {
				child.kill("SIGKILL");
				await child.exited;
			}
		}),
	);
	await Bun.write(path.join(evidence, "rpc-receipts.json"), JSON.stringify(receipts, null, 2));
	proxy.stop(true);
	bridge.stop();
	gateway.stop();
	access.stop();
	provider.stop(true);
	await fs.rm(config, { recursive: true });
};
for (const signal of ["SIGINT", "SIGTERM"] as const)
	process.once(signal, () => void stop().then(() => process.exit(0)));
setTimeout(() => void stop().then(() => process.exit(1)), 60 * 60 * 1000).unref();
console.log(`READY http://127.0.0.1:${proxy.port}`);
