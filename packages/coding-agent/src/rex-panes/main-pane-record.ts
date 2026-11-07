import { logger, postmortem } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../session/agent-session";
import { rexHostEligible } from "./component-pane";
import { paneRecordPath, removePaneRecord, sweepPaneRecords, writePaneRecord } from "./pane-records";

export interface MainPaneRecord {
	dispose(): void;
	closed(): void;
}

export function startMainPaneRecord(session: AgentSession, env: NodeJS.ProcessEnv): MainPaneRecord {
	const blockId = env.REX_BLOCK;
	if (!rexHostEligible(env, process.platform) || !blockId || !paneRecordPath(blockId)) {
		return { dispose() {}, closed() {} };
	}
	let disposed = false;
	let closed = false;
	let warned = false;
	let unsubscribe = () => {};
	let cancelExit = () => {};
	const dispose = (): void => {
		if (disposed) return;
		disposed = true;
		unsubscribe();
		cancelExit();
	};
	const fail = (error: unknown): void => {
		dispose();
		if (warned) return;
		warned = true;
		logger.warn("rex-panes: main pane record unavailable", { error: String(error) });
	};
	const remove = (): void => {
		if (closed) return;
		closed = true;
		try {
			removePaneRecord(blockId);
		} catch (error) {
			fail(error);
		}
	};
	const write = (): void => {
		if (disposed) return;
		try {
			if (session.sessionFile) {
				writePaneRecord(blockId, {
					kind: "omp",
					pid: process.pid,
					cwd: session.sessionManager.getCwd(),
					session: session.sessionFile,
				});
			} else {
				removePaneRecord(blockId);
			}
		} catch (error) {
			fail(error);
		}
	};
	try {
		sweepPaneRecords();
		write();
		if (!disposed) {
			unsubscribe = session.registerSessionChangeCallback(write);
			cancelExit = postmortem.register(
				`rex-main-pane:${blockId}`,
				reason => {
					if (reason !== postmortem.Reason.SIGHUP && reason !== postmortem.Reason.SIGTERM) remove();
					dispose();
				},
				{ exitOnly: true },
			);
		}
	} catch (error) {
		fail(error);
	}
	return {
		dispose,
		closed() {
			dispose();
			remove();
		},
	};
}
