import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { truncateToWidth } from "@oh-my-pi/pi-tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { Terminal } from "@oh-my-pi/pi-tui/terminal";
import { VERSION } from "@oh-my-pi/pi-utils/dirs";
import type { ExtensionUIContext } from "../extensibility/extensions";
import { InteractiveMode } from "../modes/interactive-mode";
import type { AgentSession } from "../session/agent-session";
import { MutedTerminal } from "./muted-terminal";
import type { PaneTab } from "./pane-manager";
import { ThreadView } from "./thread-view";

export interface PaneViewOptions {
	session: AgentSession | null;
	agentId: string;
	terminal: Terminal;
	sessionFile?: string;
	rootSessionFile?: string;
	onSubmit(text: string): void;
}

export interface PaneView {
	readonly agentId: string;
	readonly session: AgentSession | null;
	readonly ui: ExtensionUIContext;
	notice(text: string): void;
	repaint(): void;
	setTab(tab: PaneTab): void;
	finish(): Promise<void>;
	revive(session: AgentSession): Promise<void>;
	dispose(): Promise<void>;
}

export async function createPaneView(options: PaneViewOptions): Promise<PaneView> {
	const { agentId, terminal, onSubmit, sessionFile, rootSessionFile } = options;
	let session = options.session;
	const liveTerminal = new MutedTerminal(terminal);
	const threadTerminal = new MutedTerminal(terminal);
	let tab: PaneTab = session ? "live" : "thread";
	let mode: InteractiveMode | undefined;
	let snapshot: readonly string[] | undefined;
	let disposed = false;
	liveTerminal.visible = tab === "live";
	threadTerminal.visible = tab === "thread";
	const thread = new ThreadView(
		agentId,
		threadTerminal,
		sessionFile ?? session?.sessionManager.getSessionFile(),
		rootSessionFile,
		onSubmit,
	);
	terminal.start(
		data => {
			liveTerminal.feedInput(data);
			threadTerminal.feedInput(data);
		},
		() => {
			liveTerminal.resize();
			threadTerminal.resize();
		},
	);

	const repaint = (): void => {
		if (disposed) return;
		if (tab === "live" && mode) mode.ui.requestRender(true, { clearScrollback: true });
		else thread.repaint();
	};
	const setTab = (next: PaneTab): void => {
		const wasLive = liveTerminal.visible;
		tab = next;
		liveTerminal.visible = next === "live" && mode !== undefined;
		threadTerminal.visible = !liveTerminal.visible;
		thread.showSnapshot(next === "live" && !mode ? snapshot : undefined);
		thread.setVisible(threadTerminal.visible);
		if (liveTerminal.visible) {
			if (!wasLive) mode?.ui.requestRender(true, { clearScrollback: true });
		} else thread.repaint();
	};
	const attach = async (next: AgentSession): Promise<void> => {
		const replayAfterAttach = !liveTerminal.visible;
		const composer = new Composer({
			terminal: liveTerminal,
			tuiOptions: { embedded: true },
			preferences: { quiet: true, maxInlineImages: 2 },
			exit: () => {},
		});
		const created = new InteractiveMode(
			next,
			VERSION,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			composer,
			undefined,
			undefined,
			true,
		);
		try {
			await created.initEmbedded(onSubmit);
			if (disposed) {
				created.disposeEmbedded();
				return;
			}
			mode = created;
			session = next;
			snapshot = undefined;
			await thread.setSession(next);
			if (replayAfterAttach) setTab(tab);
		} catch (error) {
			created.disposeEmbedded();
			throw error;
		}
	};
	try {
		if (session) await attach(session);
		else {
			await thread.setSession(null);
			setTab("thread");
		}
	} catch (error) {
		thread.dispose();
		terminal.stop();
		throw error;
	}
	return {
		agentId,
		get session() {
			return session;
		},
		get ui() {
			const ui = mode?.getToolUIContext();
			if (!ui) throw new Error("Pane has no live UI context");
			return ui;
		},
		notice(text) {
			if (disposed) return;
			if (tab === "live" && mode)
				mode.showStatus(
					truncateToWidth(sanitizeText(text).replace(/[\r\n]+/g, " "), Math.max(1, terminal.columns - 2)),
				);
			else thread.notice(text);
		},
		repaint,
		setTab,
		async finish() {
			if (disposed) return;
			if (mode) {
				snapshot = mode.ui.render(terminal.columns).slice(-Math.max(1, terminal.rows - 3));
				liveTerminal.visible = false;
				mode.disposeEmbedded();
				mode = undefined;
			}
			session = null;
			await thread.setSession(null);
			setTab(tab);
		},
		async revive(next) {
			if (disposed || session === next) return;
			liveTerminal.visible = false;
			mode?.disposeEmbedded();
			mode = undefined;
			session = null;
			await attach(next);
		},
		async dispose() {
			if (disposed) return;
			disposed = true;
			liveTerminal.visible = false;
			threadTerminal.visible = false;
			mode?.disposeEmbedded();
			mode = undefined;
			session = null;
			snapshot = undefined;
			thread.dispose();
			terminal.stop();
		},
	};
}
