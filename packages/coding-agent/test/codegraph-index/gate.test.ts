import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as config from "../../src/codegraph-index/config";
import { gateCodegraphMcp, gateCodegraphTool } from "../../src/codegraph-index/gate";
import { jobId, useMarker } from "../../src/codegraph-index/jobs";
import type { CustomToolContext } from "../../src/extensibility/custom-tools/types";
import { DeferredMCPTool, MCPTool } from "../../src/mcp/tool-bridge";
import type { MCPServerConnection, MCPToolDefinition } from "../../src/mcp/types";
import { CodegraphTool } from "../../src/tools/codegraph";
import type { ToolSession } from "../../src/tools";
import { Settings } from "../../src/config/settings";

let temp: string;
let root: string;
let previous: string | undefined;
let previousPath: string | undefined;
let command: string;
let children: Array<Bun.Subprocess<"ignore", "ignore", "ignore">>;
let quietSpy: { mockRestore(): void };
let rustSpy: { mockRestore(): void };
beforeEach(async () => {
	temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "native-cgi-gate-")));
	previous = process.env.PI_CODING_AGENT_DIR;
	previousPath = process.env.PATH;
	process.env.PI_CODING_AGENT_DIR = temp;
	root = path.join(temp, "repo");
	fs.mkdirSync(root);
	const git = Bun.spawn(["git", "init", "-q", root], { stdout: "ignore", stderr: "ignore" });
	if ((await git.exited) !== 0) throw new Error("fixture git init failed");
	fs.writeFileSync(path.join(temp, "codegraph-index.json"), JSON.stringify({ roots: [temp] }));
	fs.writeFileSync(
		path.join(temp, "mcp.json"),
		JSON.stringify({
			mcpServers: {
				"codegraph-rs": {
					env: {
						CODEGRAPH_EMBEDDING_PROVIDER: "openai",
						CODEGRAPH_EMBEDDING_MODEL: "fixture",
						CODEGRAPH_EMBEDDING_DIMENSION: "768",
					},
				},
			},
		}),
	);
	command = path.join(temp, "codegraph");
	fs.writeFileSync(command, '#!/bin/sh\nif [ "$1" = status ]; then cat status.json; else printf "answer\\n"; fi\n', {
		mode: 0o755,
	});
	fs.writeFileSync(
		path.join(root, "status.json"),
		JSON.stringify({ state: "empty", live: { nodes: 0, edges: 0 }, build: null }),
	);
	process.env.PATH = `${temp}:${previousPath}`;
	quietSpy = spyOn(config, "quietCheckPath").mockReturnValue("/usr/bin/true");
	rustSpy = spyOn(config, "rustCommand").mockReturnValue(command);
	children = [];
});
afterEach(async () => {
	for (const child of children) {
		child.kill();
		await child.exited;
	}
	quietSpy.mockRestore();
	rustSpy.mockRestore();
	if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previous;
	if (previousPath === undefined) delete process.env.PATH;
	else process.env.PATH = previousPath;
	fs.rmSync(temp, { recursive: true, force: true });
});

test("native and agentic first-build gates return building within 22 seconds, then admit ready indexes", async () => {
	const child = Bun.spawn(["/bin/sleep", "60"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
	children.push(child);
	const jobs = path.join(temp, "codegraph-index", "jobs");
	fs.mkdirSync(jobs, { recursive: true });
	for (const kind of ["normal", "agentic"] as const)
		fs.writeFileSync(
			path.join(jobs, `${jobId(kind, root)}.json`),
			JSON.stringify({
				pid: child.pid,
				command: "/bin/sleep",
				startedAt: Date.now(),
				update: true,
				failures: 0,
				embedding: "openai|fixture|768",
			}),
		);
	const session = {
		cwd: root,
		settings: Settings.isolated(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
	} as ToolSession;
	const tool = await CodegraphTool.createIf(session);
	expect(tool).not.toBeNull();
	const start = Date.now();
	// These gates bound real child-process status probes; a fake clock cannot measure the external deadline.
	const [normal, agentic] = await Promise.all([
		tool!.execute("building", { op: "files" }).then(
			() => "unexpected success",
			error => String(error),
		),
		gateCodegraphMcp("codegraph-rs", root),
	]);
	expect(Date.now() - start).toBeLessThan(22_500);
	expect(normal).toContain("building");
	expect(agentic).toMatchObject({ ok: false, reason: expect.stringContaining("building") });
	expect(fs.existsSync(useMarker(root))).toBe(true);
	fs.mkdirSync(path.join(root, ".codegraph"));
	fs.writeFileSync(path.join(root, ".codegraph", "codegraph.db"), "fixture");
	expect(await gateCodegraphTool(root)).toEqual({ ok: true });
	fs.writeFileSync(
		path.join(root, "status.json"),
		JSON.stringify({
			state: "ready",
			live: { nodes: 7, edges: 3 },
			build: { embedder: { provider: "openai", model: "fixture", dimension: 768 } },
		}),
	);
	expect(await gateCodegraphMcp("codegraph-rs", root)).toEqual({ ok: true });
	child.kill();
	await child.exited;
	for (const kind of ["normal", "agentic"] as const)
		fs.writeFileSync(path.join(jobs, `${jobId(kind, root)}.exit`), "stopped");
	expect(await gateCodegraphTool(root)).toEqual({ ok: true });
	const result = await tool!.execute("ready", { op: "files" });
	expect(result.content).toMatchObject([{ type: "text", text: expect.stringContaining("answer") }]);
}, 30_000);

test("only the configured MCP server gates and neither direct nor deferred calls reach a paused server", async () => {
	expect(await gateCodegraphMcp("superlogical", root)).toEqual({ ok: true });
	expect(fs.existsSync(useMarker(root))).toBe(false);
	let calls = 0;
	const connection: MCPServerConnection = {
		name: "codegraph-rs",
		config: { command: "unused" },
		serverInfo: { name: "fixture", version: "1" },
		capabilities: {},
		transport: {
			connected: true,
			request<T>() {
				calls++;
				return Promise.reject<T>(new Error("blocked server called"));
			},
			async notify() {},
			async close() {},
		},
	};
	const definition: MCPToolDefinition = { name: "explore", inputSchema: { type: "object" } };
	const context = { sessionManager: { getCwd: () => root } } as CustomToolContext;
	const direct = new MCPTool(connection, definition);
	const deferred = new DeferredMCPTool("codegraph-rs", definition, async () => {
		calls++;
		return connection;
	});
	await expect(direct.execute("direct", {}, undefined, context)).rejects.toThrow("waits");
	await expect(deferred.execute("deferred", {}, undefined, context)).rejects.toThrow("waits");
	expect(calls).toBe(0);
	expect(fs.existsSync(useMarker(root))).toBe(true);
});

for (const failure of ["missing", "exit 2"] as const) {
	test(`a ready normal index remains queryable when its quiet check is ${failure}`, async () => {
		fs.mkdirSync(path.join(root, ".codegraph"));
		fs.writeFileSync(path.join(root, ".codegraph", "codegraph.db"), "fixture");
		const check = path.join(temp, "quiet");
		if (failure === "exit 2") fs.writeFileSync(check, "#!/bin/sh\nexit 2\n", { mode: 0o755 });
		spyOn(config, "quietCheckPath").mockReturnValue(check);
		expect(await gateCodegraphTool(root)).toEqual({ ok: true });
		expect(fs.existsSync(path.join(temp, "codegraph-index", "jobs", `${jobId("normal", root)}.json`))).toBe(false);
	});
}

test("an absent config leaves MCP calls ungated instead of applying configured-root defaults", async () => {
	fs.unlinkSync(path.join(temp, "codegraph-index.json"));
	expect(await config.loadConfig()).toBeUndefined();
	expect(await gateCodegraphMcp("codegraph-rs", root)).toEqual({ ok: true });
	expect(fs.existsSync(useMarker(root))).toBe(false);
});

test("an existing malformed or unreadable config still blocks the codegraph MCP server", async () => {
	const file = path.join(temp, "codegraph-index.json");
	fs.writeFileSync(file, "{");
	expect(await gateCodegraphTool(root)).toEqual({ ok: true });
	expect(await gateCodegraphMcp("codegraph-rs", root)).toMatchObject({ ok: false });
	fs.unlinkSync(file);
	fs.mkdirSync(file);
	expect(await gateCodegraphTool(root)).toEqual({ ok: true });
	expect(await gateCodegraphMcp("codegraph-rs", root)).toMatchObject({ ok: false });
	expect(await gateCodegraphMcp("superlogical", root)).toEqual({ ok: true });
});
