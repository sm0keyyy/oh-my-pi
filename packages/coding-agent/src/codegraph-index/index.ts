import * as path from "node:path";
import type { ExtensionUIContext } from "../extensibility/extensions/types";
import { indexEnabled, loadConfig, log, resolveRepo, STATUS_POLL_MS, WATCH_POLL_MS } from "./config";
import { ensure } from "./ensure";
import { useMarker } from "./jobs";
import { watchRepo, type WatchHandle } from "./watch";
import { CodegraphWidget, widgetModel, type IndexView, type RunMemory } from "./widget";

export * from "./gate";
export { cfgCodegraphIndexEnabled, cfgCodegraphIndexQuietCheck } from "./config";

export interface CodegraphMain {
	cwd: string;
	ui: ExtensionUIContext;
}

export function startCodegraphMain(main: CodegraphMain): { dispose(): void } {
	const controller = new AbortController();
	let watcher: WatchHandle | undefined;
	let takeover: NodeJS.Timeout | undefined;
	let timer: NodeJS.Timeout | undefined;
	const dispose = (): void => {
		controller.abort();
		clearInterval(takeover);
		clearInterval(timer);
		watcher?.close();
		main.ui.setWidget("codegraph", undefined);
	};
	void (async () => {
		if (!(await indexEnabled())) return;
		const cfg = await loadConfig();
		const repo = await resolveRepo(cfg, main.cwd);
		if (!repo || controller.signal.aborted) return;
		const label = path.basename(repo.mainRoot);
		const runs: RunMemory = new Map();
		let gate: IndexView | undefined;
		let busy = false;
		const claim = (): void => {
			if (controller.signal.aborted || (watcher && !watcher.closed)) return;
			watcher = watchRepo(repo, cfg);
		};
		claim();
		if (!repo.worktree)
			takeover = setInterval(() => {
				try {
					claim();
				} catch {
					dispose();
					log("watcher takeover failed");
				}
			}, WATCH_POLL_MS);
		if (!repo.worktree && (await Bun.file(useMarker(repo.mainRoot)).exists())) {
			void ensure(cfg, "agentic", repo, { update: false, signal: controller.signal }).catch(() => {
				if (!controller.signal.aborted) log("agentic start check failed");
			});
		}
		const poll = async (initial = false): Promise<void> => {
			if (busy || controller.signal.aborted) return;
			busy = true;
			try {
				if (initial || gate) {
					const result = await ensure(cfg, "normal", repo, { update: initial, signal: controller.signal });
					gate = result.ready ? undefined : result.view;
				}
				const model = await widgetModel(label, repo, gate, runs);
				if (!controller.signal.aborted)
					main.ui.setWidget("codegraph", model ? (_tui, theme) => new CodegraphWidget(model, theme) : undefined);
			} catch {
				if (!controller.signal.aborted) {
					dispose();
					log("widget refresh failed");
				}
			} finally {
				busy = false;
			}
		};
		await poll(true);
		if (!controller.signal.aborted) timer = setInterval(() => void poll(), STATUS_POLL_MS);
	})().catch(() => {
		if (!controller.signal.aborted) {
			dispose();
			log("main service start failed");
		}
	});
	return { dispose };
}
