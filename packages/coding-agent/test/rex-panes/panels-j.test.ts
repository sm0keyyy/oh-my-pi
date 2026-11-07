import { afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { type Component, TUI } from "@oh-my-pi/pi-tui";
import { getKeybindings } from "@oh-my-pi/pi-tui/keybindings";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { isRecord } from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal";
import { Setting } from "../../src/config/registry";
import { Settings } from "../../src/config/settings";
import { IrcBus } from "../../src/irc/bus";
import type { InteractiveMode } from "../../src/modes/interactive-mode";
import { AgentRegistry } from "../../src/registry/agent-registry";
import {
	registerComponentPaneHost,
	type ComponentPaneHost,
	type PanePlacement,
} from "../../src/rex-panes/component-pane";
import { DashboardPanel } from "../../src/rex-panes/panels/dashboard";
import { FeedPanel } from "../../src/rex-panes/panels/feed";
import { startRexPanels } from "../../src/rex-panes/panels";
import { cfgRexPanelFeed, cfgRexPanelUsage } from "../../src/rex-panes/panels/settings";
import { UsagePanel, usageLines } from "../../src/rex-panes/panels/usage";
import { peerRpc } from "../../src/rex-panes/peer-rpc";
import type { RexRunner } from "../../src/rex-panes/rex-cli";
import { followActiveWindow } from "../../src/rex-panes/rex-focus";
import { SessionManager } from "../../src/session/session-manager";
import { startUsagePoller } from "../../src/usage";

const cleanups: Array<() => void | Promise<void>> = [];
beforeAll(() => initTheme());
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	AgentRegistry.resetGlobalForTests();
});
const result = (value: unknown) => ({ exitCode: 0, stdout: JSON.stringify(value), stderr: "" });
function plain(component: Component): string {
	return component
		.render(200)
		.map(line => Bun.stripANSI(line))
		.join("\n");
}
function tui() {
	return new TUI(new VirtualTerminal(200, 50), false, { embedded: true });
}
async function eventually(assertion: () => void): Promise<void> {
	// Native sockets and subprocess completion use the real event loop, not fake timers.
	const deadline = Date.now() + 2000;
	for (;;) {
		try {
			assertion();
			return;
		} catch (error) {
			if (Date.now() >= deadline) throw error;
			await Bun.sleep(10);
		}
	}
}

function panels() {
	const placements: PanePlacement[] = [];
	const components: Component[] = [];
	const host: ComponentPaneHost = {
		mainLocation: () => ({ sessionId: "session:test", blockId: "block:main" }),
		agentLocation: () => undefined,
		revealAgent: async () => false,
		async open(placement, label, factory) {
			placements.push(placement);
			const done = Promise.withResolvers<undefined>();
			const component: Component =
				label === "omp: dashboard"
					? { render: () => [], invalidate() {} }
					: await factory(tui(), theme, getKeybindings(), () => done.resolve(undefined));
			components.push(component);
			return {
				blockId: "block:panel",
				result: done.promise,
				requestRender() {},
				async close() {
					component.dispose?.();
					done.resolve(undefined);
				},
			};
		},
	};
	cleanups.push(registerComponentPaneHost(host));
	const settings = Settings.isolated();
	const mode = {
		refreshRexPanelWidgets() {},
		sessionManager: { getSessionFile: () => undefined },
		session: { sessionManager: { getCwd: () => "/tmp" } },
	} as unknown as InteractiveMode;
	const service = startRexPanels({ settings, mode });
	cleanups.push(() => service.dispose());
	return { service, settings, placements, components };
}

test("PJ.a usage docks by default, floats on override, renders numeric snapshots and redraws", async () => {
	const f = panels();
	expect(await f.service.toggle("usage")).toEqual({ open: true });
	expect(f.placements[0]!.kind).toBe("dock");
	expect(usageLines(undefined)).toEqual(["CodexBar not available"]);
	await f.service.toggle("usage");
	await f.service.toggle("usage", "float");
	expect(f.placements.at(-1)!.kind).toBe("float");
	await f.service.toggle("usage");
	cfgRexPanelUsage.set(f.settings, "float");
	await f.service.toggle("usage");
	expect(f.placements.at(-1)!.kind).toBe("float");
	const settings = Settings.isolated();
	const now = new Date();
	const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
	const start = (percent: number) =>
		startUsagePoller({
			settings,
			notice() {},
			run: async argv => ({
				exitCode: 0,
				stdout: JSON.stringify(
					argv.includes("dashboard")
						? {
								schemaVersion: 1,
								generatedAt: now.toISOString(),
								providers: [
									{
										id: "claude",
										label: "Claude",
										identity: { plan: "Pro" },
										windows: [
											{
												kind: "session",
												label: "Session",
												usedPercent: percent,
												resetAt: new Date(now.getTime() + 3600_000).toISOString(),
											},
										],
										prompts: ["not displayed"],
									},
								],
							}
						: [{ provider: "claude", daily: [{ date: today, totalTokens: 1234 }] }],
				),
			}),
		});
	let poller = start(20);
	cleanups.push(() => poller.dispose());
	const component = f.components.at(-1)!;
	expect(component).toBeInstanceOf(UsagePanel);
	const redraw = spyOn((component as UsagePanel).tui, "requestRender");
	cleanups.push(() => redraw.mockRestore());
	await eventually(() => expect(plain(component)).toContain("20%"));
	expect(plain(component).split("\n")).toHaveLength(1);
	expect(plain(component)).toContain("Pro");
	expect(plain(component)).toContain("1,234");
	expect(plain(component)).not.toContain("not displayed");
	poller.dispose();
	poller = start(45);
	await eventually(() => expect(plain(component)).toContain("45%"));
	expect(redraw).toHaveBeenCalled();
	expect(
		usageLines({
			updatedAt: now.toISOString(),
			providers: [{ id: "missing", label: "Missing", windows: [], unavailable: true }],
		}),
	).toEqual(["Missing: unavailable"]);
});

test("PJ.c feed uses fixture IRC history once, orders it and appends live delivery without an editor", async () => {
	const registry = new AgentRegistry();
	const bus = new IrcBus(registry);
	registry.register({ id: "Alpha", displayName: "Alpha", kind: "sub", session: null, status: "running" });
	const panel = new FeedPanel(tui(), `${import.meta.dir}/../fixtures/threads/feed/root.jsonl`, bus);
	cleanups.push(() => panel.dispose());
	await panel.ready;
	const before = plain(panel);
	expect(before.match(/Team update\./g)).toHaveLength(1);
	expect(before.indexOf("Beta gets this.")).toBeLessThan(before.indexOf("Team update."));
	panel.handleInput("hello\r");
	expect(plain(panel)).toBe(before);
	const waiting = bus.wait("Alpha", {}, 1000);
	await bus.send({ from: "Main", to: "Alpha", body: "New live IRC" });
	await waiting;
	expect(plain(panel)).toContain("Main → Alpha: New live IRC");
	const f = panels();
	await f.service.toggle("feed");
	expect(f.placements.at(-1)!.kind).toBe("dock");
	await f.service.toggle("feed");
	cfgRexPanelFeed.set(f.settings, "float");
	await f.service.toggle("feed");
	expect(f.placements.at(-1)!.kind).toBe("float");
});

test("PJ.b dashboard follows event windows, reads a peer and sends Go to that main session", async () => {
	const dir = await fs.mkdtemp("/tmp/jpdash-");
	cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
	await fs.chmod(dir, 0o700);
	const repo = path.resolve(import.meta.dir, "../../../..");
	const gitLine = (await vcs.requireGit(repo).logOnelines(1))[0]!;
	// The peer protocol is a real socket; only Rex and bd are external fixture adapters.
	const id = "abcdef0123456789";
	const endpoint = path.join(dir, `${id}.sock`);
	const commands: Record<string, unknown>[] = [];
	const sockets = new Set<net.Socket>();
	const server = net.createServer(socket => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
		socket.setEncoding("utf8");
		let input = "";
		socket.on("data", data => {
			input += data;
			let newline: number;
			while ((newline = input.indexOf("\n")) >= 0) {
				const command: unknown = JSON.parse(input.slice(0, newline));
				input = input.slice(newline + 1);
				if (!isRecord(command) || !command.id) continue;
				commands.push(command);
				const response =
					command.type === "get_state"
						? { rpcSession: { pid: process.pid, instanceId: id, startedAt: 42, cwd: repo } }
						: command.type === "get_subagents"
							? { subagents: [{ id: "PeerWorker", status: "running" }] }
							: {};
				socket.write(`${JSON.stringify({ type: "response", id: command.id, success: true, data: response })}\n`);
			}
		});
	});
	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(endpoint, listening.resolve);
	await listening.promise;
	await fs.chmod(endpoint, 0o600);
	cleanups.push(async () => {
		for (const socket of sockets) socket.destroy();
		const closed = Promise.withResolvers<void>();
		server.close(() => closed.resolve());
		await closed.promise;
	});
	await fs.writeFile(
		path.join(dir, `${id}.json`),
		JSON.stringify({ version: 1, pid: process.pid, instanceId: id, startedAt: 42, endpoint, token: "b".repeat(64) }),
		{ mode: 0o600, flag: "wx" },
	);
	const settings = Settings.isolated();
	new Setting({ id: "todo.beads.roots", type: "array", default: [] }).override(settings, []);
	new Setting({ id: "todo.beads.globalDir", type: "string", default: dir }).override(settings, dir);
	const calls: string[][] = [];
	const run: RexRunner = async args => {
		calls.push(args);
		if (args[0] === "session")
			return result({
				active_window_id: "window:one",
				windows: ["one", "two"].map(suffix => ({
					window_id: `window:${suffix}`,
					focused_block_id: `block:${suffix}`,
					layers: [{ blocks: [{ block_id: `block:${suffix}` }] }],
				})),
			});
		if (args[0] === "block") return result({ foreground: { pid: 12345, cwd: dir } });
		return result({});
	};
	const events = Promise.withResolvers<{ exitCode: number; stdout: string; stderr: string }>();
	let stopped = false;
	const modeSession = {
		sessionManager: SessionManager.inMemory(dir),
		prompt: async () => {
			throw new Error("Wrong main session");
		},
	};
	const panel = new DashboardPanel(tui(), {
		sessionId: "session:test",
		settings,
		session: modeSession,
		run,
		peer: () => peerRpc(process.pid, { dir }),
		follow: (sessionId, changed) => {
			const follower = followActiveWindow(sessionId, changed, () => events.promise);
			return {
				dispose() {
					stopped = true;
					follower.dispose();
				},
			};
		},
		beadsRunner: async argv => ({
			exitCode: 0,
			stderr: "",
			timedOut: false,
			stdout: JSON.stringify({
				schema_version: 1,
				data: argv.includes("version")
					? { version: "1.3.4" }
					: argv.includes("where")
						? { root: dir }
						: [{ id: "global-ready", title: "Ready work", priority: 2, status: "open", issue_type: "task" }],
			}),
		}),
	});
	cleanups.push(() => panel.dispose());
	panel.start("block:dashboard");
	await eventually(() => expect(plain(panel)).toContain("Go global-ready"));
	expect(plain(panel)).toContain("PeerWorker");
	expect(plain(panel)).toContain(gitLine);
	events.resolve(
		result({
			type: "session_event",
			payload: {
				session_id: "session:test",
				event: { type: "active_window_changed", payload: { window_id: "window:two" } },
			},
		}),
	);
	await eventually(() => expect(calls.filter(args => args.includes("session.move_block"))).toHaveLength(2));
	await eventually(() => expect(plain(panel)).toContain("Go global-ready"));
	const moves = calls.filter(args => args.includes("session.move_block")).map(args => JSON.parse(args.at(-1)!));
	expect(moves).toEqual([
		{ block_id: "block:dashboard", anchor_block_id: "block:one", direction: "horizontal", ratio: 0.5 },
		{ block_id: "block:dashboard", anchor_block_id: "block:two", direction: "horizontal", ratio: 0.5 },
	]);
	panel.handleInput("\r");
	await eventually(() => expect(commands.some(command => command.type === "prompt")).toBe(true));
	expect(commands.filter(command => command.type === "prompt").map(({ id: _id, ...command }) => command)).toEqual([
		{ type: "prompt", message: "Start bead global-ready: Ready work", streamingBehavior: "followUp" },
	]);
	panel.dispose();
	expect(stopped).toBe(true);
	const f = panels();
	await f.service.toggle("dashboard", "dock");
	expect(f.placements.at(-1)!.kind).toBe("float");
});
