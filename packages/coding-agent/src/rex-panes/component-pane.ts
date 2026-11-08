import { type Component, type OverlayHandle, TUI } from "@oh-my-pi/pi-tui";
import { getKeybindings, type KeybindingsManager } from "@oh-my-pi/pi-tui/keybindings";
import type { Terminal } from "@oh-my-pi/pi-tui/terminal";
import { type Theme, theme } from "@oh-my-pi/pi-tui/theme";
import { logger } from "@oh-my-pi/pi-utils";
import { removePaneRecord, writePaneRecord } from "./pane-records";
import { newPaneToken, type PaneConnection, type PaneServer } from "./pane-server";
import type { RexCli } from "./rex-cli";
import { SocketTerminal } from "./socket-terminal";
import { PaneReopenGate, registerPaneSupervisor, type PaneSupervisor, type ReopenOutcome } from "./supervise";

export type PaneBounds = readonly [x: number, y: number, w: number, h: number];
export type PanePlacement =
	| {
			kind: "dock";
			sessionId: string;
			anchorBlockId: string;
			direction: "right" | "below";
			/** New pane's share of the split, as a fraction from 0 to 1. */
			ratio?: number;
	  }
	| { kind: "float"; sessionId: string; windowId?: string; bounds: PaneBounds };
export interface RexLocation {
	sessionId: string;
	blockId: string;
}
export type PaneComponentFactory<T> = (
	tui: TUI,
	theme: Theme,
	keybindings: KeybindingsManager,
	done: (result: T) => void,
) => Component | Promise<Component>;
export interface ComponentPane<T> {
	readonly blockId: string;
	/** Undefined when the pane closes without an answer. */
	readonly result: Promise<T | undefined>;
	requestRender(): void;
	close(): Promise<void>;
}
export interface ComponentPaneOptions {
	signal?: AbortSignal;
	/** Runs after each mounted generation, including a crash reopen. */
	onOpen?(location: RexLocation): void;
}
export interface ComponentPaneHost {
	open<T>(
		placement: PanePlacement,
		label: string,
		factory: PaneComponentFactory<T>,
		options?: ComponentPaneOptions,
	): Promise<ComponentPane<T> | undefined>;
	mainLocation(): RexLocation | undefined;
	agentLocation(agentId: string): RexLocation | undefined;
	revealAgent(agentId: string): Promise<boolean>;
	reopen(blockId: string): Promise<ReopenOutcome>;
}
export interface ComponentPaneRuntime {
	rex: RexCli;
	server: PaneServer;
	relayPath: string;
	prepareToken(token: string): Promise<string>;
}
export interface ComponentPaneHostDeps {
	mainTerminal: Terminal;
	runtime(): Promise<ComponentPaneRuntime>;
	mainLocation(): RexLocation | undefined;
	agentLocation(agentId: string): RexLocation | undefined;
	revealAgent(agentId: string): Promise<boolean>;
}

let registered: ComponentPaneHost | undefined;
export function registerComponentPaneHost(host: ComponentPaneHost): () => void {
	registered = host;
	return () => {
		if (registered === host) registered = undefined;
	};
}
export function componentPaneHost(): ComponentPaneHost | undefined {
	return registered;
}
export function rexHostEligible(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
	return env.TERM_PROGRAM === "rex" && platform === "darwin" && !!env.REX_SESSION && !!env.REX_BLOCK;
}

export function createComponentPaneHost(deps: ComponentPaneHostDeps): ComponentPaneHost & { dispose(): Promise<void> } {
	const panes = new Set<PaneSupervisor & { close(): Promise<void>; label: string; panel: boolean; blockId: string }>();
	const closedPanels = new Map<string, string>();
	const pending = new Set<Promise<ComponentPane<unknown> | undefined>>();
	let disposed = false;
	let warned = false;
	const warn = (error: unknown): void => {
		if (warned) return;
		warned = true;
		logger.warn("rex-panes: component pane unavailable; main TUI remains available", { error: String(error) });
	};
	async function open<T>(
		placement: PanePlacement,
		label: string,
		factory: PaneComponentFactory<T>,
		options?: ComponentPaneOptions,
	): Promise<ComponentPane<T> | undefined> {
		const signal = options?.signal;
		if (disposed || signal?.aborted) return undefined;
		if (!label.startsWith("omp: ")) {
			warn(new Error("Pane labels must start with omp: "));
			return undefined;
		}
		let pane: HostedPane<T> | undefined;
		try {
			const runtime = await deps.runtime();
			if (disposed || signal?.aborted) return undefined;
			pane = new HostedPane<T>(
				runtime,
				placement,
				deps.mainTerminal,
				signal,
				() => {
					if (pane) panes.delete(pane);
					if (pane?.panel) closedPanels.set(pane.label, pane.blockId);
				},
				warn,
				options?.onOpen,
			);
			panes.add(pane);
			await pane.open(label, factory);
			return pane;
		} catch (error) {
			warn(error);
			await pane?.close();
			return undefined;
		}
	}
	const supervisor: PaneSupervisor = {
		markCrashed(blockId) {
			for (const pane of panes) if (pane.markCrashed(blockId)) return true;
			return false;
		},
		async reopen(blockId) {
			for (const pane of panes) {
				const outcome = await pane.reopen(blockId);
				if (outcome.ok || outcome.reason !== "unknown-block") return outcome;
			}
			return { ok: false, reason: [...closedPanels.values()].includes(blockId) ? "panel-off" : "unknown-block" };
		},
	};
	const unregister = registerPaneSupervisor(supervisor);
	return {
		open<T>(
			placement: PanePlacement,
			label: string,
			factory: PaneComponentFactory<T>,
			options?: ComponentPaneOptions,
		) {
			const operation = open(placement, label, factory, options);
			pending.add(operation);
			void operation.finally(() => pending.delete(operation));
			return operation;
		},
		mainLocation: deps.mainLocation,
		agentLocation: deps.agentLocation,
		revealAgent: deps.revealAgent,
		reopen: blockId => supervisor.reopen(blockId),
		async dispose() {
			disposed = true;
			unregister();
			await Promise.all([...panes].map(pane => pane.close()));
			await Promise.all(pending);
			closedPanels.clear();
		},
	};
}

class HostedPane<T> implements ComponentPane<T> {
	blockId = "";
	previousBlockId = "";
	label = "";
	panel = false;
	#factory?: PaneComponentFactory<T>;
	#disconnecting?: Promise<void>;
	#reopening = false;
	readonly #gate = new PaneReopenGate(() => {
		void this.close();
	});
	readonly #answer = Promise.withResolvers<T | undefined>();
	readonly result = this.#answer.promise;
	readonly #closedSignal = Promise.withResolvers<undefined>();
	#tui?: TUI;
	#terminal?: SocketTerminal;
	#connection?: PaneConnection;
	#component?: Component;
	#overlay?: OverlayHandle;
	#unsubscribeRepaint?: () => void;
	#closing?: Promise<void>;
	#closed = false;
	#eof = false;
	#blockClosed = false;
	readonly #abort = (): void => {
		void this.close();
	};

	constructor(
		readonly runtime: ComponentPaneRuntime,
		readonly placement: PanePlacement,
		readonly mainTerminal: Terminal,
		readonly signal: AbortSignal | undefined,
		readonly released: () => void,
		readonly warn: (error: unknown) => void,
		readonly onOpen?: (location: RexLocation) => void,
	) {
		signal?.addEventListener("abort", this.#abort, { once: true });
	}

	async open(label: string, factory: PaneComponentFactory<T>): Promise<void> {
		if (this.signal?.aborted) {
			await this.close();
			return;
		}
		this.label = label;
		this.panel = /^omp: (todo|agents|usage|dashboard|feed)$/.test(label);
		if (this.panel) this.#factory = factory;
		const token = newPaneToken();
		const expected = this.runtime.server.expect(token, 10_000).then(
			connection => {
				this.#connection = connection;
				if (this.#closed) connection.output.close();
				return { connection };
			},
			error => ({ error }),
		);
		try {
			const argv = [this.runtime.relayPath, this.runtime.server.socketPath, await this.runtime.prepareToken(token)];
			if (this.#closed) return;
			const p = this.placement;
			const created =
				p.kind === "dock"
					? await this.runtime.rex.split(p.sessionId, p.anchorBlockId, p.direction, label, argv, p.ratio)
					: await this.runtime.rex.newLayer(p.sessionId, p.windowId, p.bounds, label, argv);
			this.blockId = created.blockId;
			writePaneRecord(this.blockId, { kind: "relay", pid: process.pid, group: false, label });
			const outcome = await Promise.race([expected, this.#closedSignal.promise]);
			if (!outcome) return;
			if ("error" in outcome) throw outcome.error;
			if (this.#closed) return;
			const terminal = new SocketTerminal(outcome.connection.output, {
				columns: outcome.connection.columns,
				rows: outcome.connection.rows,
				kittyEnableSequence: this.mainTerminal.kittyEnableSequence,
				appearance: this.mainTerminal.appearance,
			});
			this.#terminal = terminal;
			outcome.connection.attach({
				input: data => terminal.feedInput(data),
				resize: (columns, rows) => terminal.resize(columns, rows),
				drained: () => terminal.drained(),
				closed: () => {
					this.#eof = true;
					terminal.hostClosed();
					if (this.panel) {
						this.#gate.disconnected();
						this.#disconnecting = this.#cleanup();
					} else void this.close();
				},
			});
			if (this.#closed) return;
			const tui = new TUI(terminal, false, { embedded: true });
			this.#tui = tui;
			const produced = Promise.resolve(
				factory(tui, theme, getKeybindings(), result => {
					if (this.#closed) return;
					this.#answer.resolve(result);
					void this.close();
				}),
			).then(component => {
				if (this.#closed || this.#eof) {
					component.dispose?.();
					return undefined;
				}
				return component;
			});
			const component = await Promise.race([produced, this.#closedSignal.promise]);
			if (!component || this.#closed) return;
			this.#component = component;
			tui.start();
			this.#overlay = tui.showOverlay(component, { fullscreen: true });
			this.#unsubscribeRepaint = terminal.onRepaintNeeded(() => tui.requestRender(true));
			this.onOpen?.({ sessionId: this.placement.sessionId, blockId: this.blockId });
		} finally {
			if (this.#closed) {
				await this.#closing;
				await this.#cleanup();
			}
		}
	}

	markCrashed(blockId: string): boolean {
		if (!this.panel || this.#closed || (blockId !== this.blockId && blockId !== this.previousBlockId)) return false;
		this.#gate.markCrashed();
		return true;
	}

	async reopen(blockId: string): Promise<ReopenOutcome> {
		if (!this.panel || (blockId !== this.blockId && blockId !== this.previousBlockId))
			return { ok: false, reason: "unknown-block" };
		if (this.#closed || !this.#factory) return { ok: false, reason: "panel-off" };
		if (!this.#eof || this.#reopening) return { ok: false, reason: "already-open" };
		this.#reopening = true;
		try {
			await this.#disconnecting;
			if (this.#closed) return { ok: false, reason: "panel-off" };
			this.#gate.clear();
			this.#eof = false;
			this.#blockClosed = false;
			this.previousBlockId = this.blockId;
			await this.open(this.label, this.#factory);
			return this.#closed ? { ok: false, reason: "panel-off" } : { ok: true };
		} catch (error) {
			this.warn(error);
			await this.close();
			return { ok: false, reason: "panel-off" };
		} finally {
			this.#reopening = false;
		}
	}

	requestRender(): void {
		this.#tui?.requestRender();
	}
	close(): Promise<void> {
		if (this.#closing) return this.#closing;
		this.#closed = true;
		this.#gate.clear();
		this.#factory = undefined;
		this.#closedSignal.resolve(undefined);
		this.#answer.resolve(undefined);
		this.signal?.removeEventListener("abort", this.#abort);
		this.#closing = this.#cleanup().finally(this.released);
		return this.#closing;
	}
	async #cleanup(): Promise<void> {
		// Ending the relay first can remove the block before Rex confirms our close.
		if (this.blockId && !this.#blockClosed && !this.#eof) {
			this.#blockClosed = true;
			try {
				await this.runtime.rex.closeBlock(this.placement.sessionId, this.blockId);
				removePaneRecord(this.blockId);
			} catch (error) {
				this.warn(error);
			}
		}
		this.#unsubscribeRepaint?.();
		this.#unsubscribeRepaint = undefined;
		this.#overlay?.hide();
		this.#overlay = undefined;
		this.#tui?.setFocus(null);
		this.#tui?.stop();
		this.#tui?.clear();
		this.#tui = undefined;
		try {
			this.#component?.dispose?.();
		} catch (error) {
			this.warn(error);
		}
		this.#component = undefined;
		this.#terminal?.stop();
		this.#terminal = undefined;
		this.#connection?.output.close();
		this.#connection = undefined;
	}
}
