import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { type Component, SelectList, type SgrMouseEvent, type TUI } from "@oh-my-pi/pi-tui";
import { sanitizeDisplaySingleLine } from "@oh-my-pi/pi-tui/overlays/extensions/display-text";
import { col, text } from "@oh-my-pi/pi-tui/native/describe";
import type { NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { truncateToWidth } from "@oh-my-pi/pi-tui/render/render-utils";
import { getSelectListTheme } from "@oh-my-pi/pi-tui/theme";
import { isRecord, logger } from "@oh-my-pi/pi-utils";
import type { BdRunner } from "../../beads/cli";
import { type BeadBrief, openTodoStore } from "../../beads/store";
import type { Settings } from "../../config/settings";
import { AgentRegistry } from "../../registry/agent-registry";
import type { AgentSession } from "../../session/agent-session";
import { type PeerRpc, peerRpc } from "../peer-rpc";
import type { RexRunner } from "../rex-cli";
import { followActiveWindow, runPanelRex } from "../rex-focus";

export interface DashboardOptions {
	sessionId: string;
	settings: Settings;
	session: Pick<AgentSession, "prompt" | "sessionManager">;
	run?: RexRunner;
	follow?: typeof followActiveWindow;
	peer?: typeof peerRpc;
	beadsRunner?: BdRunner;
}

export class DashboardPanel implements Component {
	readonly #list = new SelectList([], 10, getSelectListTheme(), { search: "never", emptyText: "No ready beads." });
	#watch?: { dispose(): void; failed?: Promise<void> };
	#peer?: PeerRpc;
	#blockId = "";
	#windowId = "";
	#cwd = "Loading focused tab…";
	#log: string[] = [];
	#agents: string[] = [];
	#beads: BeadBrief[] = [];
	#go?: (bead: BeadBrief) => Promise<unknown>;
	#disposed = false;
	#failed = false;
	#busy = false;
	#chain = Promise.resolve();
	#headerRows = 0;
	readonly #run: RexRunner;

	constructor(
		readonly tui: TUI,
		readonly options: DashboardOptions,
	) {
		this.#run = options.run ?? runPanelRex;
		this.#list.onSelect = item => {
			const bead = this.#beads.find(value => value.id === item.value);
			const go = this.#go;
			if (!bead || !go || this.#busy || this.#disposed || this.#failed) return;
			this.#busy = true;
			this.#list.setItems(
				this.#beads.map(value => ({
					value: value.id,
					label: `Go ${value.id}: ${sanitizeDisplaySingleLine(value.title)}`,
					disabled: true,
				})),
			);
			void go(bead)
				.catch(() => logger.warn("rex-panels: dashboard Go failed"))
				.finally(() => {
					this.#busy = false;
					if (!this.#disposed && !this.#failed) this.#setBeads(this.#beads);
				});
		};
		this.#list.onSelectionChange = () => tui.requestRender();
	}

	start(blockId: string): void {
		this.#blockId = blockId;
		this.#watch = (this.options.follow ?? followActiveWindow)(this.options.sessionId, id => this.#change(id));
		void this.#watch.failed?.then(() => this.#fail(false));
		void this.#json(["session", "inspect", this.options.sessionId, "--json"])
			.then(value => {
				if (isRecord(value) && typeof value.active_window_id === "string" && !this.#windowId)
					this.#change(value.active_window_id);
			})
			.catch(() => this.#fail());
	}

	#change(windowId: string): void {
		if (this.#disposed || this.#failed || windowId === this.#windowId) return;
		this.#windowId = windowId;
		this.#go = undefined;
		this.#setBeads([]);
		this.#chain = this.#chain
			.then(async () => {
				if (this.#disposed || this.#failed || windowId !== this.#windowId) return;
				await this.#load(windowId);
			})
			.catch(() => this.#fail());
	}

	async #json(args: string[]): Promise<unknown> {
		const result = await this.#run(args, 10_000);
		if (result.exitCode !== 0) throw new Error("Rex dashboard request failed");
		return JSON.parse(result.stdout);
	}

	async #load(windowId: string): Promise<void> {
		this.#peer?.close();
		this.#peer = undefined;
		const session = await this.#json(["session", "inspect", this.options.sessionId, "--json"]);
		const window =
			isRecord(session) && Array.isArray(session.windows)
				? session.windows.find(value => isRecord(value) && value.window_id === windowId)
				: undefined;
		if (!isRecord(window) || !Array.isArray(window.layers)) throw new Error("Rex window unavailable");
		const ids = window.layers.flatMap(layer =>
			isRecord(layer) && Array.isArray(layer.blocks)
				? layer.blocks.flatMap(block =>
						isRecord(block) && typeof block.block_id === "string" && block.block_id !== this.#blockId
							? [block.block_id]
							: [],
					)
				: [],
		);
		ids.sort((a, b) => Number(b === window.focused_block_id) - Number(a === window.focused_block_id));
		const anchor = ids[0];
		if (!anchor) throw new Error("Rex window has no dashboard anchor");
		if (this.#disposed || this.#failed || windowId !== this.#windowId) return;
		await this.#json([
			"api",
			"call",
			"-s",
			this.options.sessionId,
			"session.move_block",
			JSON.stringify({ block_id: this.#blockId, anchor_block_id: anchor, direction: "horizontal", ratio: 0.5 }),
		]);
		if (this.#disposed || this.#failed) return;
		await this.#json([
			"api",
			"call",
			"-s",
			this.options.sessionId,
			"session.float_block",
			JSON.stringify({ block_id: this.#blockId, bounds: [0.55, 0.05, 0.43, 0.6] }),
		]);
		let cwd: string | undefined;
		let agents: string[] = [];
		let go: ((bead: BeadBrief) => Promise<unknown>) | undefined;
		for (const id of ids) {
			if (this.#disposed || this.#failed || windowId !== this.#windowId) return;
			const process = await this.#json(["block", "call", "-s", this.options.sessionId, "-b", id, "process"]);
			if (!isRecord(process)) continue;
			const candidates = [
				process.foreground,
				...(Array.isArray(process.ancestors) ? process.ancestors : []),
				process.child,
			];
			for (const candidate of candidates) {
				if (!isRecord(candidate) || typeof candidate.pid !== "number") continue;
				if (candidate.pid === globalThis.process.pid) {
					cwd = this.options.session.sessionManager.getCwd();
					agents = AgentRegistry.global()
						.list()
						.filter(ref => ref.kind === "sub")
						.map(ref => `${ref.displayName} · ${ref.status}`);
					go = bead => {
						const admitted = Promise.withResolvers<void>();
						void this.options.session
							.prompt(`Start bead ${bead.id}: ${bead.title}`, {
								streamingBehavior: "followUp",
								onPromptAdmitted: () => admitted.resolve(),
							})
							.then(() => admitted.resolve(), admitted.reject);
						return admitted.promise;
					};
				} else {
					const peer = await (this.options.peer ?? peerRpc)(candidate.pid);
					if (!peer) continue;
					if (this.#disposed || this.#failed || windowId !== this.#windowId) {
						peer.close();
						return;
					}
					this.#peer = peer;
					const state = await peer.call({ type: "get_state" }, 1500);
					const snapshot = isRecord(state) ? state.rpcSession : undefined;
					if (!isRecord(snapshot) || typeof snapshot.cwd !== "string") throw new Error("Peer cwd unavailable");
					cwd = snapshot.cwd;
					const response = await peer.call({ type: "get_subagents" }, 1500);
					agents =
						isRecord(response) && Array.isArray(response.subagents)
							? response.subagents.flatMap(ref =>
									isRecord(ref) && typeof ref.id === "string" && typeof ref.status === "string"
										? [`${ref.id} · ${ref.status}`]
										: [],
								)
							: [];
					go = bead =>
						peer.call(
							{ type: "prompt", message: `Start bead ${bead.id}: ${bead.title}`, streamingBehavior: "followUp" },
							10_000,
						);
				}
				break;
			}
			if (go) break;
		}
		let log: string[] = [];
		let beads: BeadBrief[] = [];
		if (cwd) {
			try {
				log = (await vcs.git(cwd)?.logOnelines(10)) ?? [];
			} catch {
				log = [];
			}
			try {
				beads = await openTodoStore({
					cwd,
					settings: this.options.settings,
					agentKind: "main",
					notice: () => {},
					runner: this.options.beadsRunner,
				}).ready(10);
			} catch {
				beads = [];
			}
		}
		if (this.#disposed || this.#failed || windowId !== this.#windowId) return;
		this.#cwd = cwd ?? "No omp in this tab.";
		this.#log = log;
		this.#agents = agents.slice(0, 10);
		this.#go = go;
		this.#setBeads(beads.slice(0, 10));
	}

	#setBeads(beads: BeadBrief[]): void {
		this.#beads = beads;
		this.#list.setItems(
			beads.map(bead => ({
				value: bead.id,
				label: `Go ${bead.id}: ${sanitizeDisplaySingleLine(bead.title)}`,
				disabled: !this.#go,
			})),
		);
		this.tui.requestRender();
	}
	#fail(warn = true): void {
		if (this.#failed || this.#disposed) return;
		this.#failed = true;
		this.#go = undefined;
		this.#watch?.dispose();
		this.#peer?.close();
		this.#cwd = "Dashboard unavailable";
		this.#setBeads([]);
		if (warn) logger.warn("rex-panels: dashboard unavailable");
	}
	render(width: number): readonly string[] {
		const rows = this.tui.terminal.rows;
		const header = [this.#cwd, "Ready beads"];
		this.#headerRows = header.length;
		this.#list.setMaxVisible(Math.max(1, Math.min(10, rows - 8)));
		const details = [
			"Git log",
			...(this.#log.length ? this.#log : ["No commits."]),
			"Agents",
			...(this.#agents.length ? this.#agents : ["No agents."]),
		];
		const lines = [
			...header.map(line => truncateToWidth(sanitizeDisplaySingleLine(line), width)),
			...this.#list.render(width),
			...details.map(line => sanitizeDisplaySingleLine(line)),
		];
		return [...lines.slice(0, Math.max(0, rows - 1)), "Follows tabs within this Rex session."]
			.slice(0, rows)
			.map(line => truncateToWidth(line, width));
	}
	describe(): NativeNode {
		return col([
			text(this.#cwd),
			text("Ready beads"),
			this.#list,
			text("Git log"),
			...this.#log.map(line => text(sanitizeDisplaySingleLine(line))),
			text("Agents"),
			...this.#agents.map(line => text(sanitizeDisplaySingleLine(line))),
			text("Follows tabs within this Rex session."),
		]);
	}
	handleInput(data: string): void {
		if (!this.#disposed && !this.#failed) this.#list.handleInput(data);
	}
	routeMouse(event: SgrMouseEvent, line: number, column: number): void {
		if (!this.#disposed && !this.#failed && line >= this.#headerRows)
			this.#list.routeMouse(event, line - this.#headerRows, column);
	}
	invalidate(): void {
		this.#list.invalidate();
	}
	dispose(): void {
		this.#disposed = true;
		this.#watch?.dispose();
		this.#peer?.close();
	}
}
