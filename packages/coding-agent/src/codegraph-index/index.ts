import * as path from "node:path";
import type { ExtensionUIContext } from "../extensibility/extensions/types";
import { indexEnabled, loadConfig, log, resolveRepo, STATUS_POLL_MS, WATCH_POLL_MS } from "./config";
import { ensure } from "./ensure";
import { useMarker } from "./jobs";
import { watchRepo, type WatchHandle } from "./watch";
import { CodegraphWidget, renderWidgetText, widgetModel, type IndexView, type RunMemory } from "./widget";

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
	let widgetStopped = false;
	const stopWidget = (reason: string): void => {
		if (widgetStopped) return;
		widgetStopped = true;
		clearInterval(timer);
		timer = undefined;
		main.ui.setWidget("codegraph", undefined);
		log(reason);
	};
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
		if (!cfg) return;
		const repo = await resolveRepo(cfg, main.cwd);
		if (!repo || controller.signal.aborted) return;
		const label = path.basename(repo.mainRoot);
		const runs: RunMemory = new Map();
		let gate: IndexView | undefined;
		let busy = false;
		let claimFailureLogged = false;
		const claim = (): void => {
			if (controller.signal.aborted || (watcher && !watcher.closed)) return;
			try {
				watcher = watchRepo(repo, cfg);
			} catch {
				if (!claimFailureLogged) {
					claimFailureLogged = true;
					log("watcher takeover failed");
				}
			}
		};
		claim();
		if (!repo.worktree) takeover = setInterval(claim, WATCH_POLL_MS);
		if (!repo.worktree && (await Bun.file(useMarker(repo.mainRoot)).exists())) {
			void ensure(cfg, "agentic", repo, { update: false, signal: controller.signal }).catch(() => {
				if (!controller.signal.aborted) log("agentic start check failed");
			});
		}
		const poll = async (initial = false): Promise<void> => {
			if (busy || widgetStopped || controller.signal.aborted) return;
			busy = true;
			try {
				if (initial || gate) {
					const result = await ensure(cfg, "normal", repo, { update: initial, signal: controller.signal });
					gate = result.ready ? undefined : result.view;
				}
				const model = await widgetModel(label, repo, gate, runs);
				if (!widgetStopped && !controller.signal.aborted) {
					if (!model) main.ui.setWidget("codegraph", undefined);
					else
						main.ui.setWidget("codegraph", (_tui, theme) => new CodegraphWidget(model, theme), {
							rpcLines: renderWidgetText(model),
						});
				}
			} catch {
				if (!controller.signal.aborted) stopWidget("widget refresh failed");
			} finally {
				busy = false;
			}
		};
		await poll(true);
		if (!widgetStopped && !controller.signal.aborted) timer = setInterval(() => void poll(), STATUS_POLL_MS);
	})().catch(() => {
		if (!controller.signal.aborted) {
			dispose();
			log("main service start failed");
		}
	});
	return { dispose };
}
