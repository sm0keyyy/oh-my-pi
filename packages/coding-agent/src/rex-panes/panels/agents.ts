import type { Component, TUI } from "@oh-my-pi/pi-tui";
import type { InteractiveMode } from "../../modes/interactive-mode";
import type { ComponentPaneHost } from "../component-pane";

export function createAgentsPanel(
	mode: InteractiveMode,
	tui: TUI,
	done: () => void,
	host: ComponentPaneHost,
): Component {
	return mode.createRexAgentsPanel(tui, done, async agentId => {
		if (!(await host.revealAgent(agentId))) throw new Error(`Cannot reveal agent ${agentId} in Rex`);
	});
}
