import { register } from "../config/registry";

export const cfgRexSubagentPanes = register({
	id: "rex.subagentPanes",
	type: "boolean",
	default: true,
	ui: {
		tab: "tasks",
		group: "Rex",
		label: "Subagent Panes",
		description: "Show subagent TUIs in background Rex sessions on macOS",
	},
});
