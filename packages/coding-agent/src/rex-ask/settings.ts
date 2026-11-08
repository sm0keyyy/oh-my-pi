import { register } from "../config/registry";

export const rexAskSettings = {
	float: register({
		id: "rexAsk.float",
		type: "boolean",
		default: true,
		ui: {
			tab: "tasks",
			group: "Rex",
			label: "Ask Pane",
			description: "Show operator asks in one floating pane that follows tabs",
		},
	}),
	proseCapture: register({
		id: "rexAsk.proseCapture",
		type: "boolean",
		default: true,
		ui: {
			tab: "tasks",
			group: "Rex",
			label: "Capture Prose Questions",
			description: "Offer main-session prose questions in the ask pane",
		},
	}),
};
