import { register } from "../../config/registry";

export const cfgRexPanelTodo = register({
	id: "rex.panels.todo",
	type: "enum",
	values: ["dock", "float"] as const,
	default: "dock",
	ui: {
		tab: "tasks",
		group: "Rex",
		label: "Todo Panel",
		description: "Default shape for the Rex todo panel",
	},
});

export const cfgRexPanelAgents = register({
	id: "rex.panels.agents",
	type: "enum",
	values: ["dock", "float"] as const,
	default: "dock",
	ui: {
		tab: "tasks",
		group: "Rex",
		label: "Agents Panel",
		description: "Default shape for the Rex Agents panel",
	},
});
