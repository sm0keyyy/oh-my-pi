import {
	setRunbookView,
	type RunbookDetails,
	type RunbookRunEntry,
	type RunbookView,
} from "@oh-my-pi/pi-tui/tools/runbook";
import { truncateTail } from "@oh-my-pi/pi-tui/tools/streaming-output";
import { logger, postmortem } from "@oh-my-pi/pi-utils";
import type { ToolSession } from "../tools";
import { rebuildRunbooks, RUNBOOK_RUN_CUSTOM_TYPE } from "./entries";
import { runLocal, type StepResult } from "./run-local";
import { createRunbookRex, type RunbookRex } from "./run-rex";
import { cfgRunbookStepTimeoutSeconds, cfgRunbookUnraidHost } from "./settings";

export const RUNBOOK_LINK_SCHEME = "omp-runbook";
export type RunOrigin = "tui" | "rpc";
export type RunOutcome =
	| { ok: true; jobId: string }
	| { ok: false; reason: "unknown-runbook" | "unknown-step" | "running" | "owner-gone" };
interface RegisteredBook {
	details: RunbookDetails;
	owner: RunbookOwner;
	view: RunbookView;
	repaint?: () => void;
}
export interface RunbookRunners {
	local?: typeof runLocal;
	mac?: RunbookRex;
	unraid?: RunbookRex;
}
const books = new Map<string, RegisteredBook>();
const owners = new WeakMap<ToolSession, RunbookOwner>();

export class RunbookOwner {
	readonly #ids = new Set<string>();
	readonly #sessionId: string | null | undefined;
	readonly #abort = new AbortController();
	#mac?: RunbookRex;
	#unraid?: RunbookRex;
	#disposed = false;
	#failed = false;
	#closing?: Promise<void>;
	#unregisterChange?: (() => void) | void;
	#unregisterDispose?: (() => void) | void;
	readonly #unregisterExit: () => void;
	constructor(
		readonly session: ToolSession,
		readonly runners: RunbookRunners = {},
	) {
		this.#sessionId = session.getSessionId?.();
		try {
			for (const { details, runs } of rebuildRunbooks(session.sessionManager?.getBranch() ?? []).values())
				this.add(details, runs);
		} catch (error) {
			this.fail(error);
		}
		this.#unregisterExit = postmortem.register(`runbook:${crypto.randomUUID()}`, () => this.dispose());
		this.#unregisterChange = session.registerSessionChangeCallback?.(() => {
			void this.dispose().catch(error => logger.warn("runbook: cleanup failed", { error: String(error) }));
			registerRunbookSession(session, runners);
		});
		this.#unregisterDispose = session.registerDisposeCallback?.(() => {
			void this.dispose().catch(error => logger.warn("runbook: cleanup failed", { error: String(error) }));
		});
	}
	get alive(): boolean {
		return (
			!this.#disposed &&
			!this.#failed &&
			!this.session.isDisposed?.() &&
			this.#sessionId === this.session.getSessionId?.()
		);
	}
	fail(error: unknown): void {
		if (this.#failed) return;
		this.#failed = true;
		logger.warn("runbook: unavailable; main TUI remains available", { error: String(error) });
	}
	add(details: RunbookDetails, runs: RunbookRunEntry["steps"] = []): void {
		this.#ids.add(details.runbookId);
		const book: RegisteredBook = { details, owner: this, view: { runs } };
		books.set(details.runbookId, book);
		setRunbookView(details.runbookId, () => book.view);
	}
	async persistRun(book: RegisteredBook, steps: RunbookRunEntry["steps"]): Promise<string> {
		try {
			if (steps.length && !this.#disposed && this.#sessionId === this.session.getSessionId?.()) {
				this.session.sessionManager?.appendCustomEntry(RUNBOOK_RUN_CUSTOM_TYPE, {
					runbookId: book.details.runbookId,
					steps,
				} satisfies RunbookRunEntry);
				await this.session.sessionManager?.flush();
			}
			return "";
		} catch (error) {
			this.fail(error);
			return "\nrunbook: captured results could not be saved; runbook disabled.";
		}
	}
	dispose(): Promise<void> {
		if (this.#closing) return this.#closing;
		this.#disposed = true;
		this.#unregisterChange?.();
		this.#unregisterDispose?.();
		if (owners.get(this.session) === this) owners.delete(this.session);
		this.#abort.abort();
		for (const id of this.#ids) {
			if (books.get(id)?.owner !== this) continue;
			books.delete(id);
			setRunbookView(id, undefined);
		}
		this.#closing = Promise.all([this.#mac?.dispose(), this.#unraid?.dispose()])
			.then(() => undefined)
			.finally(this.#unregisterExit);
		return this.#closing;
	}
	async execute(book: RegisteredBook, picked: number | "all", signal: AbortSignal): Promise<string> {
		const results: RunbookRunEntry["steps"] = [];
		const steps = picked === "all" ? book.details.steps.map((_, index) => index + 1) : [picked];
		let persistenceNotice = "";
		try {
			for (const n of steps) {
				const step = book.details.steps[n - 1]!;
				const combinedSignal = AbortSignal.any([signal, this.#abort.signal]);
				combinedSignal.throwIfAborted();
				if (!this.alive) throw new Error("Runbook owner is no longer live.");
				book.view.running = n;
				book.view.notice =
					step.interactive && step.host === "unraid"
						? `Step ${n} waits for input in Unraid session "omp: runbook".`
						: undefined;
				book.repaint?.();
				const timeout = cfgRunbookStepTimeoutSeconds.get(this.session.settings) * 1000;
				let result: StepResult;
				try {
					if (step.host === "mac" && !step.interactive)
						result = await (this.runners.local ?? runLocal)(
							{ ...step, cwd: step.cwd ?? this.session.cwd },
							timeout,
							combinedSignal,
						);
					else {
						const runner =
							step.host === "unraid"
								? (this.#unraid ??=
										this.runners.unraid ??
										createRunbookRex({ host: cfgRunbookUnraidHost.get(this.session.settings) }))
								: (this.#mac ??= this.runners.mac ?? createRunbookRex());
						result = await runner.run(
							step.host === "mac" ? { ...step, cwd: step.cwd ?? this.session.cwd } : step,
							`omp: runbook ${book.details.runbookId}.${n}`,
							(this.session.taskDepth ?? 0) > 0 ? (this.session.getAgentId?.() ?? undefined) : undefined,
							timeout,
							combinedSignal,
						);
					}
				} catch (error) {
					logger.warn("runbook: step failed", {
						runbookId: book.details.runbookId,
						step: n,
						error: String(error),
					});
					result = {
						exitCode: -1,
						output: `runbook: ${error instanceof Error ? error.message : String(error)}`,
					};
				}
				const entry = {
					n,
					host: step.host,
					exitCode: result.exitCode,
					tail: truncateTail(result.output.trimEnd(), { maxLines: 40, maxBytes: 1024 * 1024 }).content,
				};
				results.push(entry);
				book.view.runs = [...book.view.runs.filter(previous => previous.n !== n), entry];
				book.repaint?.();
				if (entry.exitCode !== 0) break;
			}
		} finally {
			try {
				persistenceNotice = await this.persistRun(book, results);
			} finally {
				book.view.running = undefined;
				book.view.notice = undefined;
				book.repaint?.();
			}
		}
		return (
			results
				.map(
					result =>
						`Runbook ${book.details.runbookId} step ${result.n} "${book.details.steps[result.n - 1]!.title}" on ${result.host}: exit ${result.exitCode}\n${result.tail}`,
				)
				.join("\n\n") + persistenceNotice
		);
	}
}
export function registerRunbookSession(session: ToolSession, runners?: RunbookRunners): RunbookOwner {
	let owner = owners.get(session);
	if (!owner) {
		owner = new RunbookOwner(session, runners);
		owners.set(session, owner);
	}
	return owner;
}
export async function runRunbook(runbookId: string, step: number | "all", _origin: RunOrigin): Promise<RunOutcome> {
	const book = books.get(runbookId);
	if (!book) return { ok: false, reason: "unknown-runbook" };
	if (step !== "all" && (!Number.isInteger(step) || step < 1 || step > book.details.steps.length))
		return { ok: false, reason: "unknown-step" };
	if (book.view.running !== undefined) return { ok: false, reason: "running" };
	const session = book.owner.session;
	const ownerId = session.getAgentId?.();
	if (!book.owner.alive || !session.asyncJobManager || !ownerId) return { ok: false, reason: "owner-gone" };
	try {
		if (session.sessionManager && !rebuildRunbooks(session.sessionManager.getBranch()).has(runbookId))
			return { ok: false, reason: "unknown-runbook" };
	} catch (error) {
		book.owner.fail(error);
		return { ok: false, reason: "owner-gone" };
	}
	book.view.running = step === "all" ? 1 : step;
	try {
		const jobId = session.asyncJobManager.register(
			"bash",
			`runbook ${runbookId} step ${step}`,
			({ signal }) => book.owner.execute(book, step, signal),
			{ ownerId, agentId: ownerId },
		);
		return { ok: true, jobId };
	} catch (error) {
		logger.warn("runbook: registration failed", { runbookId, error: String(error) });
		const n = step === "all" ? 1 : step;
		const failed = {
			n,
			host: book.details.steps[n - 1]!.host,
			exitCode: -1,
			tail: truncateTail(error instanceof Error ? error.message : String(error), {
				maxLines: 40,
				maxBytes: 1024 * 1024,
			}).content,
		};
		book.view.runs = [...book.view.runs.filter(previous => previous.n !== n), failed];
		try {
			await book.owner.persistRun(book, [failed]);
		} finally {
			book.view.running = undefined;
			book.repaint?.();
		}
		return { ok: false, reason: "running" };
	}
}
export async function activateRunbookLink(url: string, sessionId: string, repaint?: () => void): Promise<RunOutcome> {
	const match = /^omp-runbook:([a-zA-Z0-9-]+)\/(all|[1-9][0-9]*)$/.exec(url);
	if (!match) return { ok: false, reason: "unknown-runbook" };
	const book = books.get(match[1]!);
	if (!book || book.owner.session.getSessionId?.() !== sessionId) return { ok: false, reason: "unknown-runbook" };
	book.repaint = repaint;
	const result = await runRunbook(match[1]!, match[2] === "all" ? "all" : Number(match[2]), "tui");
	repaint?.();
	return result;
}
export async function runLatestRunbook(agentId: string, step: number | "all"): Promise<RunOutcome> {
	const book = [...books.values()].findLast(
		value => value.owner.session.getAgentId?.() === agentId && value.owner.alive,
	);
	return book ? runRunbook(book.details.runbookId, step, "tui") : { ok: false, reason: "unknown-runbook" };
}
