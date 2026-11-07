import { register } from "../config/registry";

export const cfgRexDiffReviewPane = register({
	id: "rex.diffReviewPane",
	type: "boolean",
	default: true,
	ui: {
		tab: "tasks",
		group: "Rex",
		label: "Diff Review Pane",
		description: "Open a background diff review pane after a completed main turn",
	},
});
