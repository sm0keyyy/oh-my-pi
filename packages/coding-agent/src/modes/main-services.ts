import { logger } from "@oh-my-pi/pi-utils";
import { startCodegraphMain } from "../codegraph-index";
import type { Settings } from "../config/settings";
import type { ExtensionUIContext } from "../extensibility/extensions/types";
import { startOperatorQueue } from "../operator-queue";
import { startAskPane } from "../rex-ask";
import { type MainPaneRecord, startMainPaneRecord } from "../rex-panes/main-pane-record";
import { createTabTitleRex, startTabTitle } from "../rex-panes/tab-title";
import { startDiffReview } from "../rex-review/diff-review";
import { startRexWatcher } from "../rex-watch/watcher";
import type { AgentSession } from "../session/agent-session";
import { startUsagePoller } from "../usage";

export interface MainServicesInput {
	settings: Settings;
	cwd: string;
	session: AgentSession;
	toolUi: ExtensionUIContext;
	sessionId(): string | undefined;
	askUi?: () => ExtensionUIContext | undefined;
}

export interface MainServices {
	dispose(): Promise<void>;
	closed(): void;
}

export function startMainServices(input: MainServicesInput): MainServices {
	const services: Array<{ name: string; dispose(): void | Promise<void> }> = [];
	const start = (name: string, factory: () => { dispose(): void | Promise<void> }): void => {
		try {
			services.push({ name, ...factory() });
		} catch (error) {
			logger.warn(`${name}: main service start failed`, { error: String(error) });
		}
	};
	start("rex-ask", () =>
		startAskPane({
			settings: input.settings,
			ui: input.toolUi,
			source: () => ({
				agent: "Main",
				role: "main",
				sessionId: input.sessionId(),
				sessionLabel: input.session.sessionManager.getSessionName(),
			}),
		}),
	);
	start("operator-queue", () =>
		startOperatorQueue({ ui: input.toolUi, sessionId: input.sessionId, askUi: input.askUi }),
	);
	start("codegraph-index", () => startCodegraphMain({ cwd: input.cwd, ui: input.toolUi }));
	start("rex-watch", () => startRexWatcher({ settings: input.settings }));
	let record: MainPaneRecord | undefined;
	start("rex-panes", () => {
		record = startMainPaneRecord(input.session, process.env);
		return record;
	});
	start("rex-panes", () => startTabTitle(input.session, createTabTitleRex(), process.env));
	start("rex-review", () => startDiffReview({ ...input, ui: input.toolUi }));
	start("usage", () =>
		startUsagePoller({ settings: input.settings, notice: (level, text) => input.toolUi.notify(text, level) }),
	);
	let teardown: Promise<void> | undefined;
	return {
		closed() {
			record?.closed();
		},
		dispose() {
			teardown ??= (async () => {
				for (const service of services) {
					try {
						await service.dispose();
					} catch (error) {
						logger.warn(`${service.name}: main service teardown failed`, { error: String(error) });
					}
				}
			})();
			return teardown;
		},
	};
}
