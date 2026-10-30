import { AuthStorage } from "@oh-my-pi/pi-ai";
import { getAgentDbPath } from "@oh-my-pi/pi-utils";
import { readSseEvents } from "../../utils/src/stream";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { startBridge } from "../../sessions-bridge/src/bridge";
import { PUBLIC_ORIGIN } from "../../sessions-gateway/src/protocol";
import { startGateway } from "../../sessions-gateway/src/server";
import { createAccessFixture } from "../../sessions-gateway/test/access-fixture";

const root = path.resolve(import.meta.dir, "../../..");
const widthFixture = process.env.SESSIONS_WIDTH_FIXTURE === "1";
const reviewFixture = process.env.SESSIONS_REVIEW_FIXTURE === "1";
const prefix = widthFixture ? "mobile-width-" : reviewFixture ? "review-fixes-" : "";
const cli = process.env.SESSIONS_FIXTURE_CLI ?? path.join(root, "packages/coding-agent/src/cli.ts");
if (!(await Bun.file(cli).exists())) throw new Error("The source TUI entrypoint does not exist");
const config = path.join(
	root,
	widthFixture
		? ".sessions-width-test-config"
		: reviewFixture
			? ".sessions-review-test-config"
			: ".sessions-d-test-config",
);
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
const browserStreams = new Set<AbortController>();
const bridgeStreams = new Set<AbortController>();
const receipts: unknown[] = [];
const wideLine = Array.from({ length: 100 }, (_, i) => i.toString(36).padStart(3, "x")).join("");
const widthTranscript = [
	`Path: /${wideLine}`,
	`Inline path: \`/${wideLine}\``,
	`# ${wideLine}`,
	`- ${wideLine}`,
	["```text", wideLine, wideLine, "```"].join("\n"),
	[
		"| " + Array.from({ length: 12 }, (_, i) => `Column ${i}`).join(" | ") + " |",
		"| " + Array.from({ length: 12 }, () => "---").join(" | ") + " |",
		"| " + Array.from({ length: 12 }, () => wideLine).join(" | ") + " |",
	].join("\n"),
	"    " + wideLine,
].join("\n\n");
const provider = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const url = new URL(request.url);
		if (url.pathname.endsWith("/models"))
			return Response.json({ object: "list", data: [{ id: "gpt-4.1" }, { id: "gpt-4.1-2" }] });
		if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
		const body = (await request.json()) as {
			messages: Array<{ role: string; content: unknown; tool_calls?: Array<{ function: { name: string } }> }>;
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
		const widthTool =
			widthFixture &&
			last?.role === "tool" &&
			content.includes(wideLine) &&
			!body.messages.some(message => message.tool_calls?.some(call => call.function.name === "ast_edit"))
				? {
						name: "ast_edit",
						args: {
							paths: [path.join(config, "wide.ts")],
							ops: [{ pat: "console.log($VALUE)", out: `console.warn("${wideLine}")` }],
						},
					}
				: widthFixture &&
					  body.messages.some(message => message.tool_calls?.some(call => call.function.name === "ast_edit")) &&
					  !body.messages.some(message => message.tool_calls?.some(call => call.function.name === "write"))
					? { name: "write", args: { path: "xd://resolve", content: "Apply isolated width fixture rewrites." } }
					: undefined;
		const tool =
			last?.role === "user" && content.includes("[tool]") && tools.includes("read")
				? { name: "read", args: { path: path.join(config, "sample.txt") } }
				: (widthTool ??
					(last?.role === "user" && content.includes("[agent]") && tools.includes("task")
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
						: undefined));
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
					content: widthFixture
						? widthTranscript
						: last?.role === "tool"
							? `Tool result received: ${content}`
							: `Local answer: ${content || "summary"}`,
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
await Bun.write(
	path.join(config, "sample.txt"),
	widthFixture
		? Array.from({ length: 25 }, (_, i) => `${i}: ${wideLine}`).join("\n")
		: "Local tool-render acceptance.\n",
);
if (widthFixture)
	await Bun.write(
		path.join(config, "wide.ts"),
		Array.from({ length: 60 }, () => `console.log("${wideLine}");`).join("\n"),
	);
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
const serviceHeaders = {
	"cf-access-jwt-assertion": await access.sign({ common_name: "fixture-service.access", email: undefined }),
};
const token = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
const gateway = await startGateway({
	token,
	siteDir: path.join(root, "packages/sessions-web/dist"),
	hostname: "127.0.0.1",
	port: 0,
	accessCertsUrl: access.certsUrl,
});
const proxy = Bun.serve({
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
			if (reviewFixture) {
				const auth = await AuthStorage.create(getAgentDbPath(agentDir));
				try {
					await auth.credentials.set("fake", { type: "api_key", key: crypto.randomUUID() });
				} finally {
					auth.close();
				}
			}
			const writer = Bun.file(path.join(evidence, `${prefix}${name}-tui.log`)).writer();
			const child = Bun.spawn(
				[
					process.execPath,
					cli,
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
			for (const controller of browserStreams) controller.abort();
			droppingUntil = Date.now() + ms;
			receipts.push({ event: "network_drop", at: Date.now(), ms });
			return Response.json({ ms });
		}
		if (url.pathname === "/fixture/drop-bridge") {
			for (const controller of bridgeStreams) controller.abort();
			receipts.push({ event: "bridge_drop", at: Date.now() });
			return Response.json({ dropped: true });
		}
		if (
			url.pathname.startsWith("/events/") ||
			url.pathname.startsWith("/api/session/") ||
			url.pathname === "/api/bridge"
		) {
			const isBridge = url.pathname.endsWith("/bridge");
			if (!isBridge && Date.now() < droppingUntil) return new Response("simulated network drop", { status: 503 });
			const forwarded: Record<string, string> = {
				...(isBridge ? serviceHeaders : access.headers),
				origin: PUBLIC_ORIGIN,
			};
			for (const name of [
				"content-type",
				"last-event-id",
				"idempotency-key",
				"x-omp-epoch",
				"authorization",
				"x-omp-bridge-id",
			]) {
				const value = request.headers.get(name);
				if (value) forwarded[name] = value;
			}
			const payload = request.method === "POST" ? await request.text() : undefined;
			if (payload && !isBridge)
				receipts.push({ direction: "command", frame: JSON.parse(JSON.parse(payload).line), at: Date.now() });
			const controller = new AbortController();
			const signal = AbortSignal.any([controller.signal, request.signal]);
			const upstream = await fetch(gateway.url + url.pathname + url.search, {
				method: request.method,
				headers: forwarded,
				signal,
				body: payload,
			});
			if (request.method !== "GET") return upstream;
			if (!upstream.ok || !upstream.body) return upstream;
			const active = isBridge ? bridgeStreams : browserStreams;
			active.add(controller);
			server.timeout(request, 0);
			let cancelled = false;
			const body = new ReadableStream<Uint8Array>({
				async start(writer) {
					writer.enqueue(new TextEncoder().encode("retry: 250\n\n"));
					try {
						for await (const event of readSseEvents(upstream.body!, signal)) {
							if (!event.data) continue;
							const frame = JSON.parse(event.data);
							if (!isBridge)
								receipts.push({
									direction: frame.type === "response" ? "response" : "event",
									frame,
									at: Date.now(),
								});
							writer.enqueue(
								new TextEncoder().encode(`${event.id ? `id: ${event.id}\n` : ""}data: ${event.data}\n\n`),
							);
						}
					} catch (cause) {
						if (!signal.aborted) writer.error(cause);
						cancelled = true;
					} finally {
						active.delete(controller);
						if (!cancelled) writer.close();
					}
				},
				cancel() {
					cancelled = true;
					controller.abort();
				},
			});
			return new Response(body, { headers: upstream.headers });
		}
		return access.fetch(gateway.url + url.pathname + url.search, { method: request.method });
	},
});
const bridge = startBridge({
	url: `http://127.0.0.1:${proxy.port}/events/bridge`,
	headers: { ...serviceHeaders, authorization: `Bearer ${token}` },
	dir: path.join(config, "run/rpc-sessions"),
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
	await Bun.write(path.join(evidence, `${prefix}rpc-receipts.json`), JSON.stringify(receipts, null, 2));
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
