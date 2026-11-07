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

export const cfgRexPanelUsage = register({
	id: "rex.panels.usage",
	type: "enum",
	values: ["dock", "float"] as const,
	default: "dock",
	ui: {
		tab: "tasks",
		group: "Rex",
		label: "Usage Panel",
		description: "Default shape for the Rex usage panel",
	},
});

export const cfgRexPanelFeed = register({
	id: "rex.panels.feed",
	type: "enum",
	values: ["dock", "float"] as const,
	default: "dock",
	ui: {
		tab: "tasks",
		group: "Rex",
		label: "Team Feed Panel",
		description: "Default shape for the read-only Rex team feed",
	},
});
