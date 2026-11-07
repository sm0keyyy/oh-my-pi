import { $which, isRecord, ptree } from "@oh-my-pi/pi-utils";
import type { CodexbarRunner, UsageProvider, UsageSnapshot, UsageWindow } from "./index";

export const CODEXBAR_TIMEOUT_MS = 35_000;
const MAX_DOCUMENT_CHARS = 8 * 1024 * 1024;

function document(json: string): unknown {
	if (json.length > MAX_DOCUMENT_CHARS) throw new Error("CodexBar document exceeds the size limit");
	return JSON.parse(json);
}

function identifier(value: unknown): string {
	if (typeof value !== "string" || !/^[a-z][a-z0-9_-]{0,127}$/.test(value)) {
		throw new Error("Invalid CodexBar identifier");
	}
	return value;
}

function label(value: unknown): string | undefined {
	// Do not forward identities, paths, or terminal controls in external display labels.
	return typeof value === "string" && value.length > 0 && value.length <= 128 && !/[@/\\\p{Cc}\p{Cf}]/u.test(value)
		? value
		: undefined;
}

function window(value: unknown): UsageWindow {
	if (
		!isRecord(value) ||
		typeof value.usedPercent !== "number" ||
		!Number.isFinite(value.usedPercent) ||
		value.usedPercent < 0
	) {
		throw new Error("Invalid CodexBar usage window");
	}
	const kind = identifier(value.kind);
	const result: UsageWindow = { kind, label: label(value.label) ?? kind, usedPercent: value.usedPercent };
	if (value.resetAt !== null && value.resetAt !== undefined) {
		if (typeof value.resetAt !== "string" || !Number.isFinite(Date.parse(value.resetAt))) {
			throw new Error("Invalid CodexBar reset time");
		}
		result.resetAt = new Date(value.resetAt).toISOString();
	}
	return result;
}

export function parseCodexbar(dashboardJson: string, costJson: string | undefined): UsageSnapshot {
	const dashboard = document(dashboardJson);
	if (!isRecord(dashboard) || dashboard.schemaVersion !== 1 || !Array.isArray(dashboard.providers)) {
		throw new Error("Invalid CodexBar dashboard");
	}
	const now = new Date();
	// Cost daily buckets use the host's local calendar, not UTC or the source update date.
	const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
	const costs = new Map<string, number>();
	if (costJson !== undefined) {
		const cost = document(costJson);
		if (!Array.isArray(cost)) throw new Error("Invalid CodexBar cost history");
		for (const row of cost) {
			if (!isRecord(row)) throw new Error("Invalid CodexBar cost provider");
			const id = identifier(row.provider);
			if (row.error !== null && row.error !== undefined) continue;
			if (!Array.isArray(row.daily)) throw new Error("Invalid CodexBar daily history");
			for (const day of row.daily) {
				if (!isRecord(day) || typeof day.date !== "string") throw new Error("Invalid CodexBar cost day");
				if (day.date !== today || day.totalTokens === undefined || day.totalTokens === null) continue;
				if (typeof day.totalTokens !== "number" || !Number.isSafeInteger(day.totalTokens) || day.totalTokens < 0) {
					throw new Error("Invalid CodexBar token total");
				}
				costs.set(id, day.totalTokens);
			}
		}
	}
	const providers: UsageProvider[] = dashboard.providers.map(value => {
		if (!isRecord(value) || !Array.isArray(value.windows)) throw new Error("Invalid CodexBar provider");
		const id = identifier(value.id);
		const provider: UsageProvider = { id, label: label(value.name) ?? id, windows: value.windows.map(window) };
		const plan = isRecord(value.identity) ? label(value.identity.plan) : undefined;
		if (plan) provider.plan = plan;
		const tokens = costs.get(id);
		if (tokens !== undefined) provider.todayTokens = tokens;
		if (value.error !== null && value.error !== undefined) provider.unavailable = true;
		return provider;
	});
	return { updatedAt: now.toISOString(), providers };
}

export function resolveCodexbar(binary: string): string {
	const resolved = $which(binary) ?? $which("codexbar");
	if (!resolved) throw new Error("CodexBar CLI is not available");
	return resolved;
}

export function codexbarRunner(signal: AbortSignal): CodexbarRunner {
	return async (argv, timeoutMs) => {
		const result = await ptree.exec([...argv], { timeout: timeoutMs, signal, allowNonZero: true });
		return { exitCode: result.exitCode ?? 1, stdout: result.stdout };
	};
}

export async function readCodexbar(binary: string, run: CodexbarRunner): Promise<UsageSnapshot> {
	const [dashboard, cost] = await Promise.all([
		run([binary, "dashboard", "--identity", "redacted", "--timeout", "30"], CODEXBAR_TIMEOUT_MS),
		run([binary, "cost", "--format", "json", "--days", "1"], CODEXBAR_TIMEOUT_MS),
	]);
	if (dashboard.exitCode !== 0 || cost.exitCode !== 0) throw new Error("CodexBar CLI command failed");
	return parseCodexbar(dashboard.stdout, cost.stdout);
}
