import { logger } from "@oh-my-pi/pi-utils";
import { startCodegraphMain } from "../codegraph-index";
import type { Settings } from "../config/settings";
import type { ExtensionUIContext } from "../extensibility/extensions/types";
import { startOperatorQueue } from "../operator-queue";
import { startRexWatcher } from "../rex-watch/watcher";

export interface MainServicesInput {
	settings: Settings;
	cwd: string;
	toolUi: ExtensionUIContext;
	sessionId(): string | undefined;
	askUi?: () => ExtensionUIContext | undefined;
}

export function startMainServices(input: MainServicesInput): { dispose(): Promise<void> } {
	const services: Array<{ name: string; dispose(): void | Promise<void> }> = [];
	const start = (name: string, factory: () => { dispose(): void | Promise<void> }): void => {
		try {
			services.push({ name, ...factory() });
		} catch (error) {
			logger.warn(`${name}: main service start failed`, { error: String(error) });
		}
	};
	start("operator-queue", () =>
		startOperatorQueue({ ui: input.toolUi, sessionId: input.sessionId, askUi: input.askUi }),
	);
	start("codegraph-index", () => startCodegraphMain({ cwd: input.cwd, ui: input.toolUi }));
	start("rex-watch", () => startRexWatcher({ settings: input.settings }));
	let teardown: Promise<void> | undefined;
	return {
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
