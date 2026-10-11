import { register } from "../../config/registry";

export const cfgRpcSocketEnabled = register({
	id: "rpcSocket.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "interaction",
		group: "RPC socket",
		label: "Enabled",
		description: "Serve local RPC clients from each top-level TUI. Restart the TUI after a change.",
	},
});
