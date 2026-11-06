import * as fs from "node:fs";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import type { ExtensionUIContext } from "../extensibility/extensions/types";
import { acquireLock, lockHolder } from "./lock";
import { ensureDirs, envMilliseconds, queuePaths, type QueuePaths } from "./paths";
import {
	type Answers,
	type AskQuestion,
	completeInterview,
	listPending,
	type PendingInterview,
	quarantine,
} from "./queue";

export interface OperatorQueueMain {
	ui: ExtensionUIContext;
	sessionId(): string | undefined;
	/** Resolves the current registered subagent ask host's external UI. */
	askUi?: () => ExtensionUIContext | undefined;
}
const WIDGET_KEY = "interview-queue";
const services = new WeakMap<ExtensionUIContext, { run(): Promise<void> }>();
const liveServices = new Set<{ main: OperatorQueueMain; run(): Promise<void> }>();

export async function dirCount(dir: string, excludeRequests = false): Promise<number> {
	try {
		return (await fs.promises.readdir(dir)).filter(
			n => n.endsWith(".json") && !(excludeRequests && n.endsWith(".request.json")),
		).length;
	} catch (error) {
		if (isEnoent(error)) return 0;
		throw error;
	}
}

export async function renderQuestions(
	ui: ExtensionUIContext,
	questions: AskQuestion[],
	signal?: AbortSignal,
): Promise<
	| { kind: "answered"; answers: Answers }
	| { kind: "cancelled" }
	| { kind: "aborted" }
	| { kind: "timeout"; timeoutMs: number }
> {
	if (!ui.askDialog) throw new Error("this UI has no native ask dialog");
	const timeoutMs = envMilliseconds("INTERVIEW_QUEUE_DIALOG_TIMEOUT_MS", 300_000);
	let timedOut = false;
	const deadline = ui.timeoutStartsOnPresentation ? undefined : AbortSignal.timeout(timeoutMs);
	const signals = [signal, deadline].filter((s): s is AbortSignal => s !== undefined);
	const result = await ui
		.askDialog(questions, {
			timeout: timeoutMs,
			signal: signals.length ? AbortSignal.any(signals) : undefined,
			onTimeout: () => {
				timedOut = true;
			},
		})
		.catch(error => {
			if (!signal?.aborted && !deadline?.aborted && !timedOut) throw error;
			return undefined;
		});
	if (signal?.aborted) return { kind: "aborted" };
	if (timedOut || deadline?.aborted) return { kind: "timeout", timeoutMs };
	if (!result || result.kind === "chat") return { kind: "cancelled" };
	if (result.results.length !== questions.length) throw new Error("ask dialog returned the wrong number of answers");
	const answers: Answers = Object.create(null);
	for (const [index, question] of questions.entries()) {
		const item = result.results[index];
		if (!item || item.id !== question.id) throw new Error("ask dialog results do not match the question order");
		answers[question.id] = { selected: item.selectedOptions };
		if (item.customInput !== undefined) answers[question.id]!.customInput = item.customInput;
		if ("note" in item && typeof item.note === "string") answers[question.id]!.note = item.note;
	}
	return { kind: "answered", answers };
}

type DrainResult = "busy" | "done" | "running";
async function drainPending(
	main: OperatorQueueMain,
	paths: QueuePaths,
	signal?: AbortSignal,
	mine?: (interview: PendingInterview) => boolean,
): Promise<DrainResult> {
	const lock = await acquireLock(paths, { timeoutMs: mine ? 0 : undefined, signal });
	if (!lock) {
		if (!mine && !signal?.aborted) {
			const holder = await lockHolder(paths);
			main.ui.notify(
				`${holder?.owner ?? "another process"} (pid ${holder?.pid ?? "?"}${holder?.cwd ? `, ${holder.cwd}` : ""}) holds active.lock. Answer the open dialog there, or retry when it closes.`,
				"warning",
			);
		}
		return "busy";
	}
	let answered = 0;
	let withdrawn = 0;
	let stopped = "";
	let failed = false;
	try {
		try {
			while (!signal?.aborted) {
				const ref = (await listPending(paths)).find(r => !r.interview || !mine || mine(r.interview));
				if (!ref) break;
				if (!ref.interview) {
					await quarantine(paths, ref);
					continue;
				}
				const outcome = await renderQuestions(main.askUi?.() ?? main.ui, ref.interview.questions, signal);
				if (outcome.kind === "aborted") return "done";
				if (outcome.kind === "cancelled") {
					stopped = "Cancelled.";
					break;
				}
				if (outcome.kind === "timeout") {
					logger.info(
						`operator-queue: dialog idle for ${outcome.timeoutMs} ms; interview ${ref.corrId} left pending`,
					);
					stopped = `No answer after ${Math.round(outcome.timeoutMs / 1000)} s.`;
					break;
				}
				if (await completeInterview(paths, ref.corrId, ref.interview, outcome.answers)) answered++;
				else withdrawn++;
			}
		} catch (error) {
			failed = true;
			stopped = `Drain stopped: ${String(error)}`;
			logger.warn("operator-queue: drain failed", { error: String(error) });
		}
		if (signal?.aborted || (mine && !answered && !withdrawn && !stopped)) return "done";
		const pending = await dirCount(paths.pending);
		const lines = [`Interviews answered: ${answered}. Still pending: ${pending}.`];
		if (withdrawn) lines.push(`Withdrawn by the requester before the answer: ${withdrawn}.`);
		if (stopped) lines.push(pending ? `${stopped} Run /interview-next to answer the rest.` : stopped);
		main.ui.notify(lines.join("\n"), failed ? "error" : "info");
		return "done";
	} finally {
		await lock.release();
	}
}

export async function answerPending(main: OperatorQueueMain): Promise<void> {
	const service = services.get(main.ui);
	if (service) return service.run();
	const paths = queuePaths();
	await ensureDirs(paths);
	await drainPending(main, paths);
}

/** Runs the main TUI service for text-mode commands received over its RPC socket. */
export async function answerPendingForSession(sessionId: string): Promise<boolean> {
	for (const service of liveServices) {
		if (service.main.sessionId() !== sessionId) continue;
		await service.run();
		return true;
	}
	return false;
}

export function startOperatorQueue(main: OperatorQueueMain): { dispose(): void } {
	const paths = queuePaths();
	const stop = new AbortController();
	let watcher: fs.FSWatcher | undefined;
	let timer: NodeJS.Timeout | undefined;
	let running = false;
	let scanning = false;
	let shown = -1;
	let seenSession = main.sessionId();
	let seen = new Set<string>();
	const reportError = (error: unknown): void => {
		logger.warn("operator-queue: pending watcher failed", { error: String(error) });
		if (!stop.signal.aborted)
			main.ui.notify("Interview queue watch failed; run /interview-next to check pending interviews.", "error");
	};
	const schedule = (delay = 1_000): void => {
		if (stop.signal.aborted) return;
		clearTimeout(timer);
		timer = setTimeout(() => {
			timer = undefined;
			void refresh(true).catch(reportError);
		}, delay);
		timer.unref();
	};
	const run = async (mine?: (interview: PendingInterview) => boolean): Promise<DrainResult> => {
		if (running) return "running";
		running = true;
		try {
			await ensureDirs(paths);
			return await drainPending(main, paths, stop.signal, mine);
		} finally {
			running = false;
		}
	};
	const refresh = async (allowOpen: boolean): Promise<void> => {
		if (stop.signal.aborted) return;
		if (scanning) {
			schedule();
			return;
		}
		scanning = true;
		let own: string[];
		const sessionId = main.sessionId();
		if (sessionId !== seenSession) {
			seen.clear();
			seenSession = sessionId;
		}
		try {
			const refs = await listPending(paths);
			if (stop.signal.aborted) return;
			if (shown !== refs.length)
				main.ui.setWidget(WIDGET_KEY, refs.length ? [`Interviews · ${refs.length} · /interview-next`] : undefined);
			shown = refs.length;
			own = refs.flatMap(ref =>
				ref.interview && sessionId !== undefined && ref.interview.session === sessionId ? [ref.corrId] : [],
			);
		} finally {
			scanning = false;
		}
		if (!allowOpen) {
			seen = new Set(own);
			return;
		}
		if (
			["false", "0", "no"].includes(process.env.INTERVIEW_AUTO_OPEN?.trim().toLowerCase() ?? "") ||
			!main.ui.askDialog ||
			running ||
			own.every(id => seen.has(id))
		)
			return;
		const result = await run(iv => iv.session === sessionId);
		if (result === "busy") schedule(3_000);
		else if (result === "done") await refresh(false);
	};
	const service = {
		main,
		run: async (): Promise<void> => {
			if ((await run()) === "done") await refresh(false);
		},
	};
	services.set(main.ui, service);
	liveServices.add(service);
	void ensureDirs(paths)
		.then(() => {
			if (stop.signal.aborted) return;
			watcher = fs.watch(paths.pending, (_event, filename) => {
				if (filename === null || filename.endsWith(".json")) schedule();
			});
			watcher.unref();
			watcher.on("error", reportError);
			schedule();
		})
		.catch(reportError);
	return {
		dispose: () => {
			stop.abort();
			watcher?.close();
			clearTimeout(timer);
			if (services.get(main.ui) === service) services.delete(main.ui);
			liveServices.delete(service);
			main.ui.setWidget(WIDGET_KEY, undefined);
		},
	};
}
