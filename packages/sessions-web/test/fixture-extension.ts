import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function fixture(pi: ExtensionAPI): void {
	pi.registerCommand("web-dialog", {
		description: "Local browser acceptance dialogs",
		async handler(args, ctx) {
			let result: unknown;
			switch (args.trim()) {
				case "select":
					result = await ctx.ui.select("Choose local option", [
						{ label: "One", description: "First local option" },
						{ label: "Two", description: "Second local option" },
					]);
					break;
				case "confirm":
					result = await ctx.ui.confirm("Confirm local action", "This changes only the isolated test session.");
					break;
				case "input":
					result = await ctx.ui.input("Local input", "Type a local answer");
					break;
				case "editor":
					result = await ctx.ui.editor("Local editor", "Initial local text");
					break;
				case "ask":
					if (!ctx.ui.askDialog) throw new Error("Ask dialog unavailable");
					result = await ctx.ui.askDialog([
						{
							id: "choice",
							question: "Which local option?",
							header: "Local decision",
							options: [
								{ label: "One", description: "First option", preview: "Local preview" },
								{ label: "Two", description: "Second option" },
							],
							recommended: 0,
						},
						{
							id: "multi",
							question: "Choose local checks",
							options: [{ label: "Desktop" }, { label: "Phone" }],
							multi: true,
						},
					]);
					break;
				case "status":
					ctx.ui.setStatus("fixture", "Local status");
					ctx.ui.setWidget("fixture", ["Local widget", "Second line"]);
					ctx.ui.notify("Local notification", "info");
					ctx.ui.setEditorText("Local editor injection");
					return;
				default:
					throw new Error("Unknown local dialog");
			}
			ctx.ui.notify(`Local dialog result: ${JSON.stringify(result)}`, "info");
		},
	});
}
