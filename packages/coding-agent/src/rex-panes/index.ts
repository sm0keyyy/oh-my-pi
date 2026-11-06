import type { Terminal } from "@oh-my-pi/pi-tui/terminal";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL } from "@oh-my-pi/pi-tui/overlays/session-observer-registry";
import { $which, isRecord, logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import type { ExtensionUIContext } from "../extensibility/extensions/types";
import { AgentRegistry } from "../registry/agent-registry";
import type { AgentSession } from "../session/agent-session";
import { registerSubagentAskHost, unregisterSubagentAskHost } from "../task/subagent-ask-host";
import { TASK_SUBAGENT_EVENT_CHANNEL } from "../task/types";
import { EventBus } from "../utils/event-bus";
import {
	createComponentPaneHost,
	type ComponentPaneRuntime,
	registerComponentPaneHost,
	rexHostEligible,
} from "./component-pane";
import { type OpenPane, type PaneManager, rexPanesEligible, startPaneManager } from "./pane-manager";
import { routePaneInput } from "./pane-input";
import { newPaneToken, type PaneServer, startPaneServer } from "./pane-server";
import { createPaneView, type PaneView } from "./pane-view";
import { installPaneRelay } from "./relay-install";
import { createRexCli } from "./rex-cli";
import { SocketTerminal } from "./socket-terminal";

export * from "./component-pane";
export * from "./pane-records";
export interface RexPanesMain {
	settings: Settings;
	subagentEventBus: EventBus | undefined;
	toolUi: ExtensionUIContext;
	mainTerminal: Terminal;
}

/** Main interactive TUI only. Transport starts on the first agent or component pane. */
export function startSubagentSurfaces(main: RexPanesMain): { dispose(): Promise<void> } {
	const bus = main.subagentEventBus;
	const panes = new Map<string, ExtensionUIContext>();
	const host = bus
		? registerSubagentAskHost({
				main: main.toolUi,
				subagentEventBus: bus,
				mirror: id => panes.get(id),
			})
		: undefined;
	let manager: PaneManager | undefined;
	let server: PaneServer | undefined;
	let starting: Promise<void> | undefined;
	let disposed = false;
	let runtime: ComponentPaneRuntime | undefined;
	let warned = false;
	let teardown: Promise<void> | undefined;
	const unsubscribers: Array<() => void> = [];
	const managerBus = new EventBus();
	// Keep only starts during lazy initialization, not streaming transcripts.
	const starts = new Map<string, unknown>();
	let ready = false;

	const warn = (error: unknown): void => {
		if (warned) return;
		warned = true;
		logger.warn("rex-panes: surfaces unavailable; main TUI remains available", { error: String(error) });
	};
	const sessionId = process.env.REX_SESSION;
	const blockId = process.env.REX_BLOCK;

	const components =
		rexHostEligible(process.env, process.platform) && sessionId && blockId
			? createComponentPaneHost({
					mainTerminal: main.mainTerminal,
					async runtime() {
						await ensureStarted();
						if (!runtime || disposed) throw new Error("Pane surfaces closed");
						return runtime;
					},
					mainLocation: () => ({ sessionId, blockId }),
					agentLocation: id => manager?.location(id),
					async revealAgent(id) {
						try {
							await ensureStarted();
							return (await manager?.reveal(id)) ?? false;
						} catch (error) {
							warn(error);
							return false;
						}
					},
				})
			: undefined;
	const unregisterComponents = components ? registerComponentPaneHost(components) : undefined;

	function ensureStarted(): Promise<void> {
		return (starting ??= start().catch(error => {
			for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
			starts.clear();
			throw error;
		}));
	}

	async function openPane(agentId: string, session: AgentSession, token: string): Promise<OpenPane> {
		if (!server || disposed) throw new Error("Pane surfaces closed");
		const connection = await server.expect(token, 10_000);
		const closed = Promise.withResolvers<void>();
		let disconnected = false;
		let view: PaneView | undefined;
		const terminal = new SocketTerminal(connection.output, {
			columns: connection.columns,
			rows: connection.rows,
			kittyEnableSequence: main.mainTerminal.kittyEnableSequence,
			appearance: main.mainTerminal.appearance,
		});
		connection.attach({
			input: data => terminal.feedInput(data),
			resize: (columns, rows) => terminal.resize(columns, rows),
			drained: () => terminal.drained(),
			closed: () => {
				disconnected = true;
				if (panes.get(agentId) === view?.ui) panes.delete(agentId);
				closed.resolve();
				terminal.hostClosed();
			},
		});
		try {
			view = await createPaneView({
				session,
				agentId,
				terminal,
				onSubmit: text => {
					void routePaneInput(agentId, text).then(
						outcome => {
							if (outcome.kind === "refused") view?.notice(outcome.message);
						},
						error => {
							warn(error);
							view?.notice("Could not send input to this agent");
						},
					);
				},
			});
			if (disconnected || disposed) throw new Error("Pane closed during initialization");
			const paneView = view;
			panes.set(agentId, paneView.ui);
			const unsubscribeRepaint = terminal.onRepaintNeeded(() => paneView.repaint());
			let closing: Promise<void> | undefined;
			return {
				ui: paneView.ui,
				closed: closed.promise,
				dispose() {
					if (closing) return closing;
					if (panes.get(agentId) === paneView.ui) panes.delete(agentId);
					unsubscribeRepaint();
					closing = paneView.dispose().finally(() => {
						terminal.stop();
						connection.output.close();
						closed.resolve();
					});
					return closing;
				},
			};
		} catch (error) {
			await view?.dispose();
			terminal.stop();
			connection.output.close();
			throw error;
		}
	}

	async function start(): Promise<void> {
		const binary = await $which("rex");
		if (!binary) throw new Error("rex is not on PATH");
		const relay = await installPaneRelay();
		if (!relay.ok) throw new Error(`Relay install failed: ${relay.reason}`);
		if (disposed) return;
		server = await startPaneServer();
		if (disposed) return;
		const paneServer = server;
		runtime = {
			rex: createRexCli({ binary }),
			server: paneServer,
			relayPath: relay.path,
			async prepareToken(token) {
				const hash = new Bun.CryptoHasher("sha256").update(await Bun.file(relay.path).bytes()).digest("hex");
				if (hash !== relay.sha256) throw new Error("Relay sha256 changed before launch");
				return paneServer.prepare(token);
			},
		};
		manager = startPaneManager({
			rex: runtime.rex,
			registry: AgentRegistry.global(),
			subagentEventBus: managerBus,
			socketPath: paneServer.socketPath,
			relayPath: relay.path,
			newToken: newPaneToken,
			prepareToken: runtime.prepareToken,
			openPane,
			onPaneOpened: id => host?.mirrorAvailable(id),
		});
		ready = true;
		for (const frame of starts.values()) managerBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, frame);
		starts.clear();
	}

	if (bus && rexPanesEligible(process.env, process.platform, main.settings)) {
		unsubscribers.push(
			bus.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, frame => {
				if (disposed) return;
				if (ready) managerBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, frame);
				else if (isRecord(frame) && frame.status === "started" && typeof frame.id === "string") {
					starts.set(frame.id, frame);
					void ensureStarted().catch(warn);
				}
			}),
		);
		unsubscribers.push(
			bus.on(TASK_SUBAGENT_EVENT_CHANNEL, frame => {
				if (ready && !disposed) managerBus.emit(TASK_SUBAGENT_EVENT_CHANNEL, frame);
			}),
		);
	}

	return {
		dispose() {
			if (teardown) return teardown;
			disposed = true;
			if (host) unregisterSubagentAskHost(host);
			unregisterComponents?.();
			for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
			panes.clear();
			starts.clear();
			teardown = (async () => {
				await starting?.catch(() => {});
				// Reject pending HELLOs before joining manager operations at exit.
				await server?.close().catch(warn);
				await components?.dispose().catch(warn);
				await manager?.dispose().catch(warn);
				managerBus.clear();
			})();
			return teardown;
		},
	};
}
