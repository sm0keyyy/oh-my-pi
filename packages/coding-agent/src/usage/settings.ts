import { register } from "../config/registry";

export const cfgUsageCodexbarPath = register({
	id: "usage.codexbarPath",
	type: "string",
	default: "/Applications/CodexBar.app/Contents/Helpers/CodexBarCLI",
	ui: {
		tab: "tasks",
		group: "Usage",
		label: "CodexBar Path",
		description: "CodexBar CLI executable on macOS; falls back to codexbar on PATH",
	},
});

export const cfgUsagePollSeconds = register({
	id: "usage.pollSeconds",
	type: "number",
	default: 300,
	validate(value) {
		if (value === undefined || value === null) return;
		if (typeof value !== "number" || !Number.isFinite(value) || value < 60 || value > 86_400) {
			throw new Error("usage.pollSeconds must be between 60 and 86400 seconds");
		}
	},
	ui: {
		tab: "tasks",
		group: "Usage",
		label: "Poll Seconds",
		description: "CodexBar refresh interval, from 60 to 86400 seconds",
	},
});

export const cfgUsageNoticePercent = register({
	id: "usage.noticePercent",
	type: "number",
	default: 90,
	validate(value) {
		if (value === undefined || value === null) return;
		if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
			throw new Error("usage.noticePercent must be between 0 and 100");
		}
	},
	ui: {
		tab: "tasks",
		group: "Usage",
		label: "Notice Percent",
		description: "Warn once per provider window and reset period at this used percentage",
	},
});
