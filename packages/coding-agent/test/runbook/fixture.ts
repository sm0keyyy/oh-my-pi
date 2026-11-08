import { AsyncJobManager } from "../../src/async/job-manager";
import { Settings } from "../../src/config/settings";
import { SessionManager } from "../../src/session/session-manager";
import type { ToolSession } from "../../src/tools";
import { registerRunbookSession, type RunbookRunners } from "../../src/runbook/registry";
import type { RunbookDetails } from "@oh-my-pi/pi-tui/tools/runbook";
import "../../src/runbook/settings";

export function fixture(runners?: RunbookRunners, journal = SessionManager.inMemory(process.cwd())) {
	const jobs = new AsyncJobManager({});
	const deliveries: string[] = [];
	const agentId = crypto.randomUUID();
	jobs.registerDeliverySink(agentId, (_id, text) => {
		deliveries.push(text);
	});
	const settings = Settings.isolated();
	const changes = new Set<() => void>();
	const session: ToolSession = {
		cwd: process.cwd(),
		hasUI: true,
		tuiTranscript: true,
		settings,
		sessionManager: journal,
		asyncJobManager: jobs,
		getSessionId: () => journal.getSessionId(),
		getAgentId: () => agentId,
		getSessionFile: () => journal.getSessionFile() ?? null,
		getSessionSpawns: () => "*",
		registerSessionChangeCallback: callback => {
			changes.add(callback);
			return () => {
				changes.delete(callback);
			};
		},
	};
	const owner = registerRunbookSession(session, runners);
	return {
		session,
		owner,
		journal,
		jobs,
		deliveries,
		agentId,
		adopt(next: SessionManager) {
			journal = next;
			session.sessionManager = next;
			const callbacks = Array.from(changes);
			for (const callback of callbacks) callback();
		},
		save(details: RunbookDetails, mounted = false) {
			journal.appendMessage({
				role: "toolResult",
				toolCallId: "book",
				toolName: mounted ? "write" : "runbook",
				content: [],
				details: mounted ? { xdev: { tool: "runbook", mode: "execute", inner: details } } : details,
				isError: false,
				timestamp: Date.now(),
			});
		},
		async settle() {
			await jobs.waitForAll();
			await jobs.drainDeliveries({ timeoutMs: 2000 });
		},
		async close() {
			await registerRunbookSession(session).dispose();
			await jobs.dispose();
		},
	};
}
