import { logger, postmortem } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import { codexbarRunner, readCodexbar, resolveCodexbar } from "./codexbar";
import type { CodexbarRunner, UsageSnapshot } from "./index";
import { UsageNotices } from "./notice";
import { cfgUsageCodexbarPath, cfgUsageNoticePercent, cfgUsagePollSeconds } from "./settings";

let snapshot: UsageSnapshot | undefined;
let active: { dispose(): void } | undefined;
const listeners = new Set<(snapshot: UsageSnapshot) => void>();

export function usageSnapshot(): UsageSnapshot | undefined {
	return snapshot;
}

export function onUsageChange(listener: (snapshot: UsageSnapshot) => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

function publish(value: UsageSnapshot): void {
	snapshot = value;
	for (const listener of listeners) {
		try {
			listener(value);
		} catch {
			listeners.delete(listener);
			logger.warn("usage: snapshot listener failed and was removed");
		}
	}
}

export function startUsagePoller(main: {
	settings: Settings;
	notice(level: "warning", text: string): void;
	run?: CodexbarRunner;
}): { dispose(): void } {
	if (active) return { dispose() {} };
	const controller = new AbortController();
	const notices = new UsageNotices();
	const run = main.run ?? codexbarRunner(controller.signal);
	let disposed = false;
	let failed = false;
	let timer: NodeJS.Timeout;
	const unavailable = (): void => {
		if (!failed) logger.warn("usage: CodexBar unavailable; usage numbers cannot be refreshed");
		failed = true;
		publish({
			updatedAt: new Date().toISOString(),
			providers: snapshot?.providers.length
				? snapshot.providers.map(provider => ({
						id: provider.id,
						label: provider.label,
						plan: provider.plan,
						windows: [],
						unavailable: true,
					}))
				: [{ id: "codexbar", label: "CodexBar", windows: [], unavailable: true }],
		});
	};
	const poll = async (): Promise<void> => {
		try {
			if (process.platform !== "darwin") {
				unavailable();
				return;
			}
			const path = cfgUsageCodexbarPath.get(main.settings);
			const value = await readCodexbar(main.run ? path : resolveCodexbar(path), run);
			if (disposed) return;
			const partial = value.providers.some(provider => provider.unavailable);
			if (partial && !failed) logger.warn("usage: CodexBar provider unavailable");
			failed = partial;
			notices.check(value, cfgUsageNoticePercent.get(main.settings), main.notice);
			publish(value);
		} catch {
			// CLI errors can contain identities and paths. Expose only the unavailable state.
			if (!disposed) unavailable();
		} finally {
			if (!disposed && process.platform === "darwin") {
				try {
					timer = setTimeout(() => void poll(), cfgUsagePollSeconds.get(main.settings) * 1000);
					timer.unref();
				} catch {
					unavailable();
				}
			}
		}
	};
	const service = {
		dispose(): void {
			if (disposed) return;
			disposed = true;
			clearTimeout(timer);
			controller.abort();
			unregister();
			if (active === service) active = undefined;
		},
	};
	const unregister = postmortem.register("usage", () => service.dispose());
	active = service;
	// Defer the first CLI read so startup and immediate teardown never wait on CodexBar.
	timer = setTimeout(() => void poll(), 0);
	timer.unref();
	return service;
}
