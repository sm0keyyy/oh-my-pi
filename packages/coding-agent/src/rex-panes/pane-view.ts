import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import type { Terminal } from "@oh-my-pi/pi-tui/terminal";
import { VERSION } from "@oh-my-pi/pi-utils/dirs";
import type { ExtensionUIContext } from "../extensibility/extensions";
import { InteractiveMode } from "../modes/interactive-mode";
import type { AgentSession } from "../session/agent-session";

export interface PaneViewOptions {
	session: AgentSession;
	agentId: string;
	terminal: Terminal;
	onSubmit(text: string): void;
}

export interface PaneView {
	readonly agentId: string;
	readonly session: AgentSession;
	readonly ui: ExtensionUIContext;
	notice(text: string): void;
	repaint(): void;
	dispose(): Promise<void>;
}

export async function createPaneView(options: PaneViewOptions): Promise<PaneView> {
	const composer = new Composer({
		terminal: options.terminal,
		preferences: { quiet: true, maxInlineImages: 2 },
		exit: () => {},
	});
	const mode = new InteractiveMode(
		options.session,
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
		await mode.initEmbedded(options.onSubmit);
	} catch (error) {
		mode.disposeEmbedded();
		throw error;
	}
	const ui = mode.getToolUIContext();
	if (!ui) throw new Error("Pane UI context was not initialized");
	let disposed = false;
	return {
		agentId: options.agentId,
		session: options.session,
		ui,
		notice(text) {
			if (!disposed) mode.showStatus(text);
		},
		repaint() {
			if (!disposed) mode.ui.requestRender(true, { clearScrollback: true });
		},
		async dispose() {
			if (disposed) return;
			disposed = true;
			mode.disposeEmbedded();
		},
	};
}
