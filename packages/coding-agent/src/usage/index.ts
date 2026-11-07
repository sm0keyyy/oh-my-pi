export interface UsageWindow {
	kind: string;
	label: string;
	usedPercent: number;
	resetAt?: string;
}

export interface UsageProvider {
	id: string;
	label: string;
	plan?: string;
	windows: UsageWindow[];
	todayTokens?: number;
	unavailable?: boolean;
}

export interface UsageSnapshot {
	updatedAt: string;
	providers: UsageProvider[];
}

export type CodexbarRunner = (
	argv: readonly string[],
	timeoutMs: number,
) => Promise<{ exitCode: number; stdout: string }>;

export * from "./codexbar";
export * from "./poller";
