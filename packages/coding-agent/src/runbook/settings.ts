import { register } from "../config/registry";
export const cfgRunbookStepTimeoutSeconds = register({
	id: "runbook.stepTimeoutSeconds",
	type: "number",
	default: 600,
	validate(value) {
		if (
			value !== undefined &&
			value !== null &&
			(typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 86400)
		)
			throw new Error("runbook.stepTimeoutSeconds must be greater than 0 and at most 86400.");
	},
	ui: { tab: "tools", group: "Runbook", label: "Step timeout", description: "Maximum seconds for a runbook step" },
});
export const cfgRunbookUnraidHost = register({
	id: "runbook.unraidHost",
	type: "string",
	default: "unraid",
	validate(value) {
		if (
			value !== undefined &&
			value !== null &&
			(typeof value !== "string" || !value || value.startsWith("-") || /\s|\0/.test(value))
		)
			throw new Error("runbook.unraidHost must be a Rex host label or address without whitespace.");
	},
	ui: { tab: "tools", group: "Runbook", label: "Unraid host", description: "Rex host label for Unraid runbook steps" },
});
