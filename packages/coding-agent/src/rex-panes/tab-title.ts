import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { isRecord, logger, ptree } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../session/agent-session";
import { rexHostEligible } from "./component-pane";
import type { RexRunner } from "./rex-cli";

export interface TabTitleRex {
	setWindowLabel(sessionId: string, windowId: string, label: string): Promise<void>;
	windowOf(sessionId: string, blockId: string): Promise<{ windowId: string; label: string } | undefined>;
}

export function createTabTitleRex(run?: RexRunner): TabTitleRex {
	const runner: RexRunner =
		run ??
		(async (args, timeout) => {
			const result = await ptree.exec(["rex", ...args], { timeout, allowNonZero: true });
			return { exitCode: result.exitCode ?? -1, stdout: result.stdout, stderr: result.stderr };
		});
	async function call(sessionId: string, method: string, args: Record<string, string>): Promise<string> {
		const result = await runner(
			[
				"--autostart=false",
				"api",
				"call",
				"-s",
				sessionId,
				method,
				JSON.stringify({ session_id: sessionId, ...args }),
			],
			10_000,
		);
		if (result.exitCode !== 0) throw new Error(`Rex ${method} failed (exit ${result.exitCode})`);
		return result.stdout;
	}
	return {
		async setWindowLabel(sessionId, windowId, label) {
			await call(sessionId, "session.set_window_label", { window_id: windowId, label });
		},
		async windowOf(sessionId, blockId) {
			const view: unknown = JSON.parse(await call(sessionId, "session.view", {}));
			if (!isRecord(view) || !Array.isArray(view.windows)) throw new Error("Rex returned no windows");
			for (const window of view.windows) {
				if (!isRecord(window) || !Array.isArray(window.layers))
					throw new Error("Rex returned invalid window layers");
				for (const layer of window.layers) {
					if (!isRecord(layer) || !Array.isArray(layer.blocks))
						throw new Error("Rex returned invalid layer blocks");
					if (!layer.blocks.some(block => isRecord(block) && block.block_id === blockId)) continue;
					if (typeof window.window_id !== "string" || typeof window.label !== "string") {
						throw new Error("Rex returned an invalid window label");
					}
					return { windowId: window.window_id, label: window.label };
				}
			}
			return undefined;
		},
	};
}

export function tabTitleFor(sessionTitle: string | undefined, phases: readonly TodoPhase[]): string | undefined {
	let active: string | undefined;
	for (const phase of phases) {
		active = phase.tasks.find(task => task.status === "in_progress")?.content;
		if (active !== undefined) break;
	}
	const parts = [sessionTitle, active].map(part => part?.replace(/\p{Cc}/gu, "").trim()).filter(Boolean);
	const title = parts.join(" · ");
	if (!title) return undefined;
	return Array.from(title).slice(0, 128).join("");
}

export function startTabTitle(session: AgentSession, rex: TabTitleRex, env: NodeJS.ProcessEnv): { dispose(): void } {
	const sessionId = env.REX_SESSION;
	const blockId = env.REX_BLOCK;
	if (!rexHostEligible(env, process.platform) || !sessionId || !blockId) return { dispose() {} };
	const labels = new Map<string, string>();
	const overridden = new Set<string>();
	let disposed = false;
	let running = false;
	let dirty = false;
	let observed: string | undefined;
	let debounce: NodeJS.Timeout | undefined;
	let poll: NodeJS.Timeout | undefined;
	const unsubscribers: Array<() => void> = [];
	const dispose = (): void => {
		if (disposed) return;
		disposed = true;
		clearTimeout(debounce);
		clearInterval(poll);
		for (const unsubscribe of unsubscribers) unsubscribe();
	};
	const title = (): string | undefined => tabTitleFor(session.sessionName, session.getTodoPhases());
	const refresh = async (): Promise<void> => {
		if (disposed) return;
		clearTimeout(debounce);
		debounce = undefined;
		if (running) {
			dirty = true;
			return;
		}
		running = true;
		try {
			observed = title();
			if (!observed) return;
			const window = await rex.windowOf(sessionId, blockId);
			if (disposed || !window || overridden.has(window.windowId)) return;
			const previous = labels.get(window.windowId);
			if (previous !== undefined && window.label !== previous) {
				overridden.add(window.windowId);
				return;
			}
			const next = title();
			if (!next || disposed) return;
			if (next !== window.label) await rex.setWindowLabel(sessionId, window.windowId, next);
			labels.set(window.windowId, next);
			observed = next;
		} catch (error) {
			dispose();
			logger.warn("rex-panes: tab title unavailable", { error: String(error) });
		} finally {
			running = false;
			if (dirty) {
				dirty = false;
				void refresh();
			}
		}
	};
	const schedule = (): void => {
		if (disposed) return;
		clearTimeout(debounce);
		debounce = setTimeout(() => void refresh(), 1000);
		debounce.unref();
	};
	try {
		unsubscribers.push(
			session.sessionManager.onSessionNameChanged(schedule),
			session.registerSessionChangeCallback(schedule),
			session.subscribe(event => {
				if (event.type === "agent_end" || (event.type === "tool_execution_end" && event.toolName === "todo")) {
					schedule();
				}
			}),
		);
		// Direct todo edits append user_todo_edit without a session event.
		poll = setInterval(() => {
			if (title() !== observed) void refresh();
		}, 1000);
		poll.unref();
		void refresh();
	} catch (error) {
		dispose();
		logger.warn("rex-panes: tab title unavailable", { error: String(error) });
	}
	return { dispose };
}
