import type { Component, TUI } from "@oh-my-pi/pi-tui";
import type { Settings } from "../../config/settings";
import type { InteractiveMode } from "../../modes/interactive-mode";
import { componentPaneHost, type ComponentPane, type ComponentPaneHost, type RexLocation } from "../component-pane";
import { createAgentsPanel } from "./agents";
import { cfgRexPanelAgents, cfgRexPanelTodo } from "./settings";
import { TodoPanel } from "./todo";

export * from "./settings";

export type PanelName = "todo" | "agents";
export interface RexPanels {
	toggle(name: PanelName, shape?: "dock" | "float"): Promise<{ open: boolean }>;
	isOpen(name: PanelName): boolean;
	dispose(): Promise<void>;
}

interface PanelDefinition {
	shape(): "dock" | "float";
	create(tui: TUI, done: () => void, host: ComponentPaneHost, entry: OpenPanel): Component;
}
interface OpenPanel {
	abort: AbortController;
	location: RexLocation;
	pane?: ComponentPane<void>;
}

export function startRexPanels(main: { settings: Settings; mode: InteractiveMode }): RexPanels {
	const open = new Map<PanelName, OpenPanel>();
	const pending = new Map<PanelName, Promise<{ open: boolean }>>();
	let disposed = false;
	const definitions: Record<PanelName, PanelDefinition> = {
		todo: {
			shape: () => cfgRexPanelTodo.get(main.settings),
			create: (tui, _done, _host, entry) => new TodoPanel(main.mode, tui, () => entry.location, entry.abort.signal),
		},
		agents: {
			shape: () => cfgRexPanelAgents.get(main.settings),
			create: (tui, done, host) => createAgentsPanel(main.mode, tui, done, host),
		},
	};
	const release = (name: PanelName, entry: OpenPanel): void => {
		entry.abort.abort();
		if (open.get(name) !== entry) return;
		open.delete(name);
		main.mode.refreshRexPanelWidgets();
	};
	async function toggle(name: PanelName, shape?: "dock" | "float"): Promise<{ open: boolean }> {
		if (disposed) return { open: false };
		const current = open.get(name);
		if (current) {
			try {
				await current.pane?.close();
			} finally {
				release(name, current);
			}
			return { open: false };
		}
		const host = componentPaneHost();
		const location = host?.mainLocation();
		if (!host || !location) throw new Error("toggle_pane needs the interactive TUI in Rex");
		const definition = definitions[name];
		const entry: OpenPanel = { abort: new AbortController(), location };
		open.set(name, entry);
		try {
			const placement =
				(shape ?? definition.shape()) === "float"
					? { kind: "float" as const, sessionId: location.sessionId, bounds: [0.55, 0.05, 0.43, 0.6] as const }
					: {
							kind: "dock" as const,
							sessionId: location.sessionId,
							anchorBlockId: location.blockId,
							direction: "right" as const,
						};
			const pane = await host.open<void>(
				placement,
				`omp: ${name}`,
				(tui, _theme, _keys, done) => definition.create(tui, () => done(), host, entry),
				{ signal: entry.abort.signal },
			);
			if (!pane) {
				release(name, entry);
				return { open: false };
			}
			entry.pane = pane;
			entry.location = { sessionId: location.sessionId, blockId: pane.blockId };
			void pane.result.then(() => release(name, entry));
			if (disposed) {
				await pane.close();
				release(name, entry);
				return { open: false };
			}
			main.mode.refreshRexPanelWidgets();
			return { open: true };
		} catch (error) {
			release(name, entry);
			throw error;
		}
	}
	return {
		toggle(name, shape) {
			const operation = (pending.get(name) ?? Promise.resolve()).then(() => toggle(name, shape));
			pending.set(name, operation);
			const clear = (): void => {
				if (pending.get(name) === operation) pending.delete(name);
			};
			void operation.then(clear, clear);
			return operation;
		},
		isOpen: name => open.get(name)?.pane !== undefined,
		async dispose() {
			disposed = true;
			const entries = [...open];
			for (const [, entry] of entries) entry.abort.abort();
			try {
				await Promise.all([...pending.values(), ...entries.map(([, entry]) => entry.pane?.close())]);
			} finally {
				for (const [name, entry] of entries) release(name, entry);
			}
		},
	};
}
