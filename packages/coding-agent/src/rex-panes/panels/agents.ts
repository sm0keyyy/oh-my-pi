import type { TUI } from "@oh-my-pi/pi-tui";
import type { AgentHubOverlayComponent } from "@oh-my-pi/pi-tui/overlays/agent-hub";
import type { InteractiveMode } from "../../modes/interactive-mode";
import type { ComponentPaneHost } from "../component-pane";

export function createAgentsPanel(
	mode: InteractiveMode,
	tui: TUI,
	done: () => void,
	host: ComponentPaneHost,
): AgentHubOverlayComponent {
	const hub = mode.createRexAgentsPanel(tui, done, async agentId => {
		if (!(await host.revealAgent(agentId))) hub.openChat(agentId);
	});
	return hub;
}
