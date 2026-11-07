import { register } from "../config/registry";

export const cfgRexWatcher = register({
	id: "rex.watcher",
	type: "boolean",
	default: true,
	ui: {
		tab: "tasks",
		group: "Rex",
		label: "Watcher",
		description: "Watch Rex sessions for job notices, host outages, and layout changes on macOS",
	},
});

export const cfgRexWatcherScript = register({
	id: "rex.watcherScript",
	type: "string",
	default: "~/.config/rex/omp-watch.lua",
	ui: {
		tab: "tasks",
		group: "Rex",
		label: "Watcher Script",
		description: "Path to the Rex session watcher Lua script",
	},
});
