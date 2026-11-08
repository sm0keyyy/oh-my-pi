import type { Agent, AgentMessage, AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Message, Model, TextContent, ToolChoice } from "@oh-my-pi/pi-ai";
import { isRecord, logger, prompt, stringProperty, untilAborted } from "@oh-my-pi/pi-utils";
import { openTodoStore, type TodoBeadsInfo, type TodoStore } from "../beads";
import type { Settings } from "../config/settings";
import eagerTaskPrompt from "../prompts/system/eager-task.md" with { type: "text" };
import eagerTodoPrompt from "../prompts/system/eager-todo.md" with { type: "text" };
import midRunTodoNudgePrompt from "../prompts/system/mid-run-todo-nudge.md" with { type: "text" };
import postCompactionTodoPrompt from "../prompts/system/post-compaction-todo.md" with { type: "text" };
import todoDoneNudgePrompt from "../prompts/system/todo-done-nudge.md" with { type: "text" };
import {
	getLatestTodoPhasesFromEntries,
	isTodoPhase,
	normalizeInProgressTask,
	USER_TODO_EDIT_CUSTOM_TYPE,
} from "../tools/todo";
import { type TodoItem, type TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { buildNamedToolChoice } from "../utils/tool-choice";
import type { AgentSessionEvent } from "./agent-session-events";
import type { CustomMessage } from "./messages";
import type { SessionManager } from "./session-manager";
import type { TodoDoneInput } from "./todo-done-check";

import { cfgTaskBatch, cfgTaskEager } from "../task/settings";
import {
	cfgTodoDoneCheck,
	cfgTodoEager,
	cfgTodoEnabled,
	cfgTodoMidRunNudgeAfter,
	cfgTodoMidRunNudgeMax,
	cfgTodoReminders,
	cfgTodoRemindersMax,
} from "../tools/settings";
const MUTATING_TOOLS: Record<string, true> = {
	bash: true,
	eval: true,
	edit: true,
	write: true,
	ast_edit: true,
};
const MID_RUN_NUDGE_MESSAGE_TYPE = "mid-run-todo-nudge";
/** Message type of the hidden first-turn reminder {@link TodoTracker.createEagerTodoPrelude} builds. */
export const EAGER_TODO_PRELUDE_MESSAGE_TYPE = "eager-todo-prelude";
const MARKDOWN_PROMPT_PREFIX_RE = /^(?:>\s*)?(?:(?:[-*+]|\d+[.)])\s+)*/;
const PROMPT_LABEL_RE = /^(?:q(?:uestion)?|ask)\s*\d*\s*[:.)-]\s*/i;
const INLINE_EMPHASIS_RE = /(\*\*|__)(.*?)\1/g;
const OPTION_LINE_RE = /^(?:[-*+]|\d+[.)])\s+\S/;
const RECOMMENDATION_RE = /^(?:i(?:'d| would)?\s+recommend|(?:my\s+)?recommendation)\b/i;
const CHOICE_CONFIRMATION_RE = /^(?:go|proceed|continue|stick)\s+with\b/i;
const QUESTION_PROMPT_RE =
	/^(?:what|which|when|where|why|how|who|whom|whose|do|does|did|can|could|would|will|should|is|are|am|may|shall)\b/i;
const USER_DIRECTED_PROMPT_RE = /\b(?:you|your|we|our)\b/i;
const ADDRESSEE_RE = /\b(?:you|your)\b/i;
// Imperatives ("tell me", "message me") and conditional permission ("If you confirm, I'll…").
const USER_RESPONSE_CUE_RE =
	/^(?:please\s+)?(?:confirm|reply|choose|pick|decide|advise|answer|approve)\b|^(?:please\s+)?(?:let\s+me\s+know|(?:tell|message|ping)\s+me)\b|^(?:if|once|when)\s+you\s+(?:confirm|approve|agree|allow|okay|ok|give)\b/i;
// Strip a connective only before an explicit address/permission cue; bare response
// words can be nouns ("Finally, answer validation is complete.").
const LEADING_CONNECTIVE_RE =
	/^(?:and|or|so|then|also|otherwise|alternatively|separately|finally)\b,?\s*(?=(?:please\b|let\s+me\s+know\b|(?:tell|message|ping)\s+me\b|(?:if|once|when)\s+you\b))/i;
// Western terminators need trailing whitespace (so `foo?: string` stays whole); CJK ones do not.
const SENTENCE_BREAK_RE = /(?<=[.!?…])\s+|(?<=[。！？])/;
/**
 * A trailing question mark is the universal signal that a line is a question, but
 * the English word/pronoun gates above exist to filter incidental "?" out of prose
 * (e.g. a TypeScript `foo?: string` tail). Non-English text has no cheap word list,
 * yet any non-ASCII character in a "?"/"？"-terminated line reliably marks it as
 * genuine prose — CJK/Japanese/Korean, Spanish `¿…?`, accented Latin — so treat it
 * as a real user-directed question. Fixes non-Latin prompts going undetected (#7803).
 */
const NON_ASCII_TEXT_RE = /[^\x00-\x7F]/;

// A question wrapped whole in italics (`*…*`, `_…_`) — or the `*…*` that
// INLINE_EMPHASIS_RE leaves of `***…***` — must still match the ^-anchored
// QUESTION_PROMPT_RE. Strikethrough is deliberately absent: `~~…~~` marks the
// author as having discarded the span, so unwrapping it would promote a retracted
// question back to a live one and idle the session waiting for an answer nobody is going to give.
const WRAPPED_EMPHASIS_RE = /^(\*\*\*|\*\*|\*|___|__|_)([\s\S]+)\1$/;

interface PromptLine {
	text: string;
	hadPromptLabel: boolean;
}

/** Capabilities the todo tracker borrows from its owning session. */
export interface TodoTrackerHost {
	agent: Agent;
	sessionManager: SessionManager;
	settings: Settings;
	model(): Model | undefined;
	agentKind(): "main" | "sub";
	cwd?(): string;
	emitSessionEvent(event: AgentSessionEvent): Promise<void>;
	scheduleAgentContinue(options: { source: string; generation?: number }): void;
	promptGeneration(): number;
	hasPendingAsyncWake(): boolean;
	getActiveToolNames(): string[];
	getEnabledToolNames(): string[];
	toolRegistry(): Map<string, AgentTool>;
	planModeEnabled(): boolean;
	/** Whether prewalk will hand off after its plan nudge owns todo creation. */
	prewalkWillHandoff(): boolean;
	consumeLastServedToolChoiceLabel(): string | undefined;
	judgeTodoDone(input: TodoDoneInput, signal: AbortSignal): Promise<boolean | undefined>;
}

interface TodoCommit {
	previous: TodoPhase[];
	assigned: TodoPhase[];
	epoch: number;
	revision: number;
}

/** Owns canonical todo state, eager preludes, and completion reminders. */
export class TodoTracker {
	readonly #host: TodoTrackerHost;
	#phases: TodoPhase[] = [];
	#reminderCount = 0;
	#reminderAwaitingProgress = false;
	#mutationsSinceLastTouch = 0;
	#midRunNudgeCount = 0;
	#currentTaskKey: string | undefined;
	#taskVersion = 0;
	readonly #changedFiles = new Set<string>();
	readonly #doneNudged = new Set<string>();

	#store: TodoStore | undefined;
	#storeCwd: string | undefined;
	#storeSessionId: string;
	#queue: Promise<void> = Promise.resolve();
	#epoch = 0;
	#revision = 0;
	#base: TodoPhase[] | undefined;
	#syncState: "pending" | "synced" | undefined;
	readonly #commits = new Set<TodoCommit>();
	#lastRefreshAt = -Infinity;
	#lastRefreshRevision = -1;
	readonly #listeners = new Set<(phases: readonly TodoPhase[]) => void>();
	constructor(host: TodoTrackerHost, store?: TodoStore) {
		this.#host = host;
		this.#store = store;
		this.#storeCwd = host.cwd?.() ?? host.sessionManager.getCwd();
		this.#storeSessionId = host.sessionManager.getSessionId();
	}

	get store(): TodoStore {
		const cwd = this.#host.cwd?.() ?? this.#host.sessionManager.getCwd();
		const sessionId = this.#host.sessionManager.getSessionId();
		if (!this.#store || this.#storeCwd !== cwd || this.#storeSessionId !== sessionId) {
			this.#storeCwd = cwd;
			this.#storeSessionId = sessionId;
			this.#store = openTodoStore({
				cwd,
				settings: this.#host.settings,
				agentKind: this.#host.agentKind(),
				notice: (level, message) => {
					void this.#host
						.emitSessionEvent({ type: "notice", level, message, source: "beads" })
						.catch(error => logger.warn("beads: notice failed", { error: String(error) }));
				},
			});
		}
		return this.#store;
	}

	/** Returns a defensive clone of the current todo phases. */
	get phases(): TodoPhase[] {
		return this.#clonePhases(this.#phases);
	}

	/** Replaces local state without writing beads. Invalidates an earlier async refresh. */
	setPhases(phases: TodoPhase[]): void {
		this.#epoch++;
		this.#base = undefined;
		this.#syncState = undefined;
		this.#replacePhases(phases);
	}

	#replacePhases(phases: TodoPhase[]): void {
		this.#revision++;
		this.#phases = this.#clonePhases(phases);
		const current = this.#currentTask();
		if (current?.key !== this.#currentTaskKey) {
			this.#currentTaskKey = current?.key;
			this.#taskVersion++;
			this.#changedFiles.clear();
		}
		// Every state write lands here — the native tool, a Cursor sync, or a
		// bridged call — so the nudge budget re-arms on the progress it
		// rations. Views, failed batches, and unchanged reads never arrive.
		this.#midRunNudgeCount = 0;
		for (const listener of this.#listeners) {
			try {
				listener(this.phases);
			} catch (error) {
				logger.warn("todo: subscriber failed", { error: String(error) });
			}
		}
	}

	/** Rehydrates a branch without replaying its mutations against beads. */
	syncFromBranch(refresh = true, options?: { discardPending?: boolean }): void {
		const branch = this.#host.sessionManager.getBranch();
		const phases = getLatestTodoPhasesFromEntries(branch);
		if (!Bun.deepEquals(phases, this.#phases)) this.setPhases(phases);
		this.#base = undefined;
		this.#syncState = undefined;
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (entry.type !== "custom" || entry.customType !== "todo_beads_sync" || !isRecord(entry.data)) continue;
			if (entry.data.state === "pending" && Array.isArray(entry.data.base) && entry.data.base.every(isTodoPhase)) {
				this.#base = this.#clonePhases(entry.data.base);
				this.#syncState = "pending";
			} else if (entry.data.state === "synced") {
				this.#syncState = "synced";
			}
			break;
		}
		if (options?.discardPending && this.#syncState === "pending") {
			this.#base = undefined;
			this.#persistSync({ state: "synced" });
		}
		// History changes rebase a pending store before a later writer can use its old base.
		if (options?.discardPending || (refresh && this.#syncState !== "pending" && this.store.info.state !== "pending"))
			void this.refresh();
	}

	/** Commits writers through identity assignment; agent tools opt into auto-advance. */
	commit(next: TodoPhase[], options?: { advance?: boolean }): void {
		const store = this.store;
		const previous = this.phases;
		const assigned = store.assignIds(previous, next);
		if (options?.advance) normalizeInProgressTask(assigned);
		this.#replacePhases(assigned);
		const commit: TodoCommit = { previous, assigned, epoch: this.#epoch, revision: this.#revision };
		this.#commits.add(commit);
		this.#queue = this.#queue
			.then(async () => {
				if (commit.epoch !== this.#epoch) return;
				const identities = assigned
					.flatMap(phase => [phase, ...phase.tasks])
					.map(value => ({ value, id: value.id }));
				let info = await store.write(this.#syncState === "pending" ? (this.#base ?? previous) : previous, assigned);
				if (commit.epoch !== this.#epoch) return;
				this.#applyRemintedIds(identities, commit.epoch);
				let synced: TodoPhase[] | undefined;
				if (info.state === "synced") {
					const result = await store.refresh(assigned, undefined);
					info = result.info;
					synced = result.phases;
				}
				if (commit.epoch !== this.#epoch) return;
				if (info.state === "pending") this.#base ??= previous;
				else if (info.state === "synced") this.#base = this.#clonePhases(synced ?? assigned);
				if (commit.revision === this.#revision) this.#replacePhases(synced ?? assigned);
				this.#persistSync(info);
				if (info.state !== "off") this.#persistPhases();
			})
			.catch(error => logger.error("todo: commit failed", { error: String(error) }))
			.finally(() => {
				this.#commits.delete(commit);
			});
	}

	#applyRemintedIds(before: readonly { value: { id?: string }; id?: string }[], epoch: number): void {
		const changes = new Map<string, string>();
		for (const { value, id } of before) {
			if (id && value.id && id !== value.id) changes.set(id, value.id);
		}
		if (changes.size === 0) return;
		const remap = (phases: TodoPhase[]): void => {
			for (const phase of phases) {
				if (phase.id) phase.id = changes.get(phase.id) ?? phase.id;
				for (const task of phase.tasks) {
					if (task.id) task.id = changes.get(task.id) ?? task.id;
				}
			}
		};
		remap(this.#phases);
		if (this.#base) remap(this.#base);
		for (const queued of this.#commits) {
			if (queued.epoch !== epoch) continue;
			remap(queued.previous);
			remap(queued.assigned);
		}
		const previousRevision = this.#revision;
		this.#replacePhases(this.#phases);
		for (const queued of this.#commits) {
			if (queued.epoch === epoch && queued.revision === previousRevision) queued.revision = this.#revision;
		}
	}

	async flush(): Promise<TodoBeadsInfo> {
		let queue: Promise<void>;
		do {
			queue = this.#queue;
			await queue;
		} while (queue !== this.#queue);
		return this.store.info;
	}

	/** Refreshes after queued writes; pending lists reconcile at explicit load/prompt boundaries. */
	async refresh(options?: { maxAgeMs?: number }): Promise<void> {
		const epoch = this.#epoch;
		const store = this.store;
		const revision = this.#revision;
		const rebasePhases = this.#syncState !== "pending" && store.info.state === "pending" ? this.phases : undefined;
		this.#queue = this.#queue
			.then(async () => {
				if (epoch !== this.#epoch) return;
				if (revision !== this.#revision && !rebasePhases) return;
				if (
					options?.maxAgeMs !== undefined &&
					store.info.state === "synced" &&
					this.#syncState !== "pending" &&
					this.#lastRefreshRevision === this.#revision &&
					Date.now() - this.#lastRefreshAt < options.maxAgeMs
				)
					return;
				const pending = this.#syncState === "pending" || store.info.state === "pending";
				const phases = rebasePhases ?? this.#phases;
				const base =
					this.#syncState === "pending" ? this.#base : store.info.state === "pending" ? phases : undefined;
				const result = await store.refresh(phases, base);
				if (epoch !== this.#epoch || revision !== this.#revision) return;
				this.#replacePhases(result.phases);
				if (result.info.state === "synced") {
					this.#base = this.phases;
					this.#lastRefreshAt = Date.now();
					this.#lastRefreshRevision = this.#revision;
					if (pending) this.#persistPhases();
				}
				this.#persistSync(result.info);
			})
			.catch(error => logger.error("todo: refresh failed", { error: String(error) }));
		await this.#queue;
	}

	subscribe(listener: (phases: readonly TodoPhase[]) => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	#persistPhases(): void {
		if (
			JSON.stringify(getLatestTodoPhasesFromEntries(this.#host.sessionManager.getBranch())) ===
			JSON.stringify(this.#phases)
		)
			return;
		this.#host.sessionManager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: this.phases });
	}

	#persistSync(info: TodoBeadsInfo): void {
		if (info.state === "off" || info.state === this.#syncState) return;
		this.#syncState = info.state;
		this.#host.sessionManager.appendCustomEntry(
			"todo_beads_sync",
			info.state === "pending"
				? { state: "pending", base: this.#clonePhases(this.#base ?? this.#phases) }
				: { state: "synced" },
		);
	}

	/** Returns a defensive clone suitable for snapshots and branch state. */
	clonePhases(phases: TodoPhase[]): TodoPhase[] {
		return this.#clonePhases(phases);
	}

	/** Resets per-prompt reminder and mutation budgets. */
	resetCycle(): void {
		this.#reminderCount = 0;
		this.#reminderAwaitingProgress = false;
		this.#mutationsSinceLastTouch = 0;
		this.#midRunNudgeCount = 0;
		this.#changedFiles.clear();
		this.#taskVersion++;
	}

	/** Records a completed tool result before asynchronous event processing begins. */
	onToolResult(toolName: string, isError: boolean, paths?: readonly string[]): void {
		if (toolName === "todo") {
			this.#mutationsSinceLastTouch = 0;
		} else if (!isError && MUTATING_TOOLS[toolName]) {
			this.#mutationsSinceLastTouch++;
		}
		if (!isError && (toolName === "edit" || toolName === "write" || toolName === "ast_edit")) {
			for (const path of paths ?? []) {
				if (this.#changedFiles.size >= 50) break;
				this.#changedFiles.add(path);
			}
		}
		this.#reminderAwaitingProgress = false;
	}

	/** Detects whether a successful todo result came from an init operation. */
	onTodoResultDetails(details: Record<string, unknown>, toolCallId: string | undefined): boolean {
		const phases = details.phases;
		if (!Array.isArray(phases) || !phases.every(isTodoPhase)) return false;
		const detailOp = stringProperty(details, "op");
		if (detailOp) return detailOp === "init";
		if (!toolCallId) return false;
		for (let index = this.#host.agent.state.messages.length - 1; index >= 0; index--) {
			const message = this.#host.agent.state.messages[index];
			if (!message) continue;
			const op = toolCallOpFromMessage(message, toolCallId);
			if (op) return op === "init";
		}
		return false;
	}

	/** Builds the first-turn eager todo prelude and optional forced tool choice. */
	createEagerTodoPrelude(
		promptText: string | undefined,
	): { message: AgentMessage; toolChoice?: ToolChoice } | undefined {
		const mode = cfgTodoEager.get(this.#host.settings);
		if (mode === "default" || !cfgTodoEnabled.get(this.#host.settings)) return undefined;
		if (this.#host.planModeEnabled() || this.#phases.length > 0) return undefined;
		// An actionable prewalk drives todo creation in a plan-first-then-todo order;
		// the forced eager prelude's "call todo first this turn" contradicts it (#10510).
		if (this.#host.prewalkWillHandoff()) return undefined;
		if (promptText !== undefined) {
			if (this.#host.agent.state.messages.some(message => message.role === "user")) return undefined;
			const trimmedPromptText = promptText.trimEnd();
			if (trimmedPromptText.endsWith("?") || trimmedPromptText.endsWith("!")) return undefined;
		}
		const activeToolNames = this.#host.getActiveToolNames();
		if (!activeToolNames.includes("todo")) {
			logger.warn("Eager todo enforcement skipped because todo is not active", { activeToolNames });
			return undefined;
		}
		const message: AgentMessage = {
			role: "custom",
			customType: EAGER_TODO_PRELUDE_MESSAGE_TYPE,
			content: prompt.render(eagerTodoPrompt, { ...this.#buildEagerPreludeContext(), forced: mode === "always" }),
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		};
		if (promptText === undefined || mode === "preferred") return { message };
		const model = this.#host.model();
		const toolChoice = buildNamedToolChoice("todo", model);
		if (!toolChoice) {
			logger.warn(
				"Eager todo proceeding with the reminder only because the current model does not support a forced todo tool_choice",
				{ modelApi: model?.api, modelId: model?.id },
			);
			return { message };
		}
		return { message, toolChoice };
	}

	/** Builds the first-turn eager task-delegation prelude. */
	createEagerTaskPrelude(promptText: string | undefined): AgentMessage | undefined {
		if (cfgTaskEager.get(this.#host.settings) !== "always") return undefined;
		if (this.#host.agentKind() === "sub" || this.#host.planModeEnabled()) return undefined;
		if (promptText !== undefined) {
			if (this.#host.agent.state.messages.some(message => message.role === "user")) return undefined;
			const trimmed = promptText.trimEnd();
			if (trimmed.endsWith("?") || trimmed.endsWith("!")) return undefined;
		}
		if (!this.#host.getEnabledToolNames().includes("task")) return undefined;
		return {
			role: "custom",
			customType: "eager-task-prelude",
			content: prompt.render(eagerTaskPrompt, this.#buildEagerPreludeContext()),
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		};
	}

	/** Builds reminder-only eager preludes after compaction. */
	buildPostCompactionEagerNudges(): AgentMessage[] {
		const nudges: AgentMessage[] = [];
		const todo = this.createEagerTodoPrelude(undefined);
		if (todo) nudges.push(todo.message);
		const task = this.createEagerTaskPrelude(undefined);
		if (task) nudges.push(task);
		return nudges;
	}

	/** Builds the open-list reminder queued by each committed compaction. */
	createPostCompactionTodoReminder(): CustomMessage | undefined {
		if (
			!cfgTodoEnabled.get(this.#host.settings) ||
			this.#host.planModeEnabled() ||
			!this.#host.getActiveToolNames().includes("todo")
		)
			return undefined;
		const open = this.#phases
			.flatMap(phase => phase.tasks)
			.filter(task => task.status !== "completed" && task.status !== "abandoned");
		if (open.length === 0) return undefined;
		const current = this.#currentTask()?.task;
		const items = current ? [current, ...open.filter(task => task !== current)].slice(0, 10) : open.slice(0, 10);
		return {
			role: "custom",
			customType: "post-compaction-todo",
			content: prompt.render(postCompactionTodoPrompt, {
				...this.#buildEagerPreludeContext(),
				current,
				items,
			}),
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		};
	}

	/** Checks a terminal assistant turn and schedules continuation for incomplete todos. */
	async checkCompletion(message: AssistantMessage): Promise<boolean> {
		if (this.#host.consumeLastServedToolChoiceLabel() === "user-force") return false;
		if (this.#host.planModeEnabled()) return false;
		if (isAwaitingUserAnswer(message) || this.#host.hasPendingAsyncWake()) return false;
		const generation = this.#host.promptGeneration();
		const sessionId = this.#host.sessionManager.getSessionId();
		if (await this.#checkDone(message)) return true;
		if (generation !== this.#host.promptGeneration() || sessionId !== this.#host.sessionManager.getSessionId())
			return false;
		if (this.#reminderAwaitingProgress) {
			logger.debug("Todo completion: prior reminder still awaiting agent action; staying silent", {
				attempt: this.#reminderCount,
			});
			return false;
		}
		if (
			!cfgTodoReminders.get(this.#host.settings) ||
			!cfgTodoEnabled.get(this.#host.settings) ||
			!this.#host.getActiveToolNames().includes("todo")
		) {
			this.#reminderCount = 0;
			this.#reminderAwaitingProgress = false;
			return false;
		}
		const remindersMax = cfgTodoRemindersMax.get(this.#host.settings);
		if (this.#reminderCount >= remindersMax) {
			logger.debug("Todo completion: max reminders reached", { count: this.#reminderCount });
			return false;
		}
		const phases = this.phases;
		if (phases.length === 0) {
			this.#reminderCount = 0;
			this.#reminderAwaitingProgress = false;
			return false;
		}
		const incompleteByPhase = phases
			.map(phase => ({
				name: phase.name,
				tasks: phase.tasks
					.filter(
						(task): task is TodoItem & { status: "pending" | "in_progress" } =>
							task.status === "pending" || task.status === "in_progress",
					)
					.map(task => ({ content: task.content, status: task.status, ...(task.id ? { id: task.id } : {}) })),
			}))
			.filter(phase => phase.tasks.length > 0);
		const incomplete = incompleteByPhase.flatMap(phase => phase.tasks);
		if (incomplete.length === 0) {
			this.#reminderCount = 0;
			this.#reminderAwaitingProgress = false;
			return false;
		}
		this.#reminderCount++;
		const todoList = incompleteByPhase
			.map(phase => `- ${phase.name}\n${phase.tasks.map(task => `  - ${task.content}`).join("\n")}`)
			.join("\n");
		const reminder =
			`<system-reminder>\n` +
			`You stopped with ${incomplete.length} incomplete todo item(s):\n${todoList}\n\n` +
			`Please continue working on these tasks or mark them complete if finished.\n` +
			`(Reminder ${this.#reminderCount}/${remindersMax})\n` +
			`</system-reminder>`;
		logger.debug("Todo completion: sending reminder", {
			incomplete: incomplete.length,
			attempt: this.#reminderCount,
		});
		await this.#host.emitSessionEvent({
			type: "todo_reminder",
			todos: incomplete,
			attempt: this.#reminderCount,
			maxAttempts: remindersMax,
		});
		const reminderMessage: Message = {
			role: "developer",
			content: [{ type: "text", text: reminder }],
			attribution: "agent",
			timestamp: Date.now(),
		};
		this.#mutationsSinceLastTouch = 0;
		this.#reminderAwaitingProgress = true;
		this.#host.agent.appendMessage(reminderMessage);
		this.#host.sessionManager.appendMessage(reminderMessage);
		this.#host.scheduleAgentContinue({
			source: "todo-reminder",
			generation: this.#host.promptGeneration(),
		});
		return true;
	}

	/** Takes the next hidden mid-run reconciliation nudge, if its budget and guards allow. */
	takeMidRunNudge(): AgentMessage | null {
		if (this.#mutationsSinceLastTouch < Math.max(1, cfgTodoMidRunNudgeAfter.get(this.#host.settings))) return null;
		const max = cfgTodoMidRunNudgeMax.get(this.#host.settings);
		if (max > 0 && this.#midRunNudgeCount >= max) return null;
		if (!cfgTodoEnabled.get(this.#host.settings) || !cfgTodoReminders.get(this.#host.settings)) return null;
		if (this.#host.planModeEnabled() || !this.#host.getActiveToolNames().includes("todo")) return null;
		const incomplete = this.#phases
			.flatMap(phase => phase.tasks)
			.filter(task => task.status === "pending" || task.status === "in_progress");
		if (incomplete.length === 0) return null;
		this.#mutationsSinceLastTouch = 0;
		this.#midRunNudgeCount++;
		const { toolRefs } = this.#buildEagerPreludeContext();
		const reminder = prompt.render(midRunTodoNudgePrompt, {
			toolRefs,
			incompleteCount: incomplete.length,
			plural: incomplete.length !== 1,
			current: this.#currentTask()?.task,
		});
		logger.debug("Mid-run todo nudge fired", {
			incomplete: incomplete.length,
			nudge: this.#midRunNudgeCount,
		});
		return {
			role: "custom",
			customType: MID_RUN_NUDGE_MESSAGE_TYPE,
			content: reminder,
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		};
	}

	#currentTask(): { key: string; task: TodoItem } | undefined {
		for (const phase of this.#phases) {
			const task = phase.tasks.find(task => task.status === "in_progress");
			if (!task) continue;
			const id = stringProperty(task, "id");
			return {
				key: JSON.stringify([this.#host.sessionManager.getSessionId(), id ?? [phase.name, task.content]]),
				task,
			};
		}
		return undefined;
	}

	async #checkDone(message: AssistantMessage): Promise<boolean> {
		if (
			message.stopReason !== "stop" ||
			message.content.some(content => content.type === "toolCall" || content.type === "image") ||
			!message.content.some(content => content.type === "text" && /\S/.test(content.text)) ||
			!cfgTodoEnabled.get(this.#host.settings) ||
			cfgTodoDoneCheck.get(this.#host.settings) === "off" ||
			!this.#host.getActiveToolNames().includes("todo") ||
			this.#changedFiles.size === 0
		)
			return false;
		const current = this.#currentTask();
		if (!current || this.#doneNudged.has(current.key)) return false;
		const generation = this.#host.promptGeneration();
		const version = this.#taskVersion;
		const sessionId = this.#host.sessionManager.getSessionId();
		const signal = AbortSignal.timeout(8_000);
		let done: boolean | undefined;
		try {
			done = await untilAborted(signal, () =>
				this.#host.judgeTodoDone(
					{
						task: current.task.content,
						details: current.task.details,
						files: [...this.#changedFiles],
					},
					signal,
				),
			);
		} catch (error) {
			// An optional judge failure leaves the existing reminder ladder in charge.
			logger.debug("todo-done: check failed", { error: String(error) });
		}
		if (
			!done ||
			signal.aborted ||
			generation !== this.#host.promptGeneration() ||
			version !== this.#taskVersion ||
			sessionId !== this.#host.sessionManager.getSessionId() ||
			this.#currentTask()?.key !== current.key ||
			this.#host.planModeEnabled() ||
			cfgTodoDoneCheck.get(this.#host.settings) === "off"
		)
			return false;
		this.#doneNudged.add(current.key);
		const nudge: AgentMessage = {
			role: "custom",
			customType: "todo-done-nudge",
			content: prompt.render(todoDoneNudgePrompt, {
				...this.#buildEagerPreludeContext(),
				task: current.task.content,
				id: stringProperty(current.task, "id"),
			}),
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		};
		this.#host.agent.appendMessage(nudge);
		this.#host.sessionManager.appendMessage(nudge);
		this.#host.scheduleAgentContinue({ source: "todo-done-nudge", generation });
		return true;
	}

	#buildEagerPreludeContext(): { toolRefs: Record<string, string>; taskBatch: boolean } {
		const wireName = (name: string): string => {
			const tool = this.#host.toolRegistry().get(name);
			return typeof tool?.customWireName === "string" ? tool.customWireName : name;
		};
		return {
			toolRefs: { task: wireName("task"), todo: wireName("todo") },
			taskBatch: cfgTaskBatch.get(this.#host.settings),
		};
	}

	#clonePhases(phases: TodoPhase[]): TodoPhase[] {
		return phases.map(phase => ({
			...phase,
			tasks: phase.tasks.map(task => ({ ...task, ...(task.notes ? { notes: [...task.notes] } : {}) })),
		}));
	}
}

function toolCallOpFromMessage(message: AgentMessage, toolCallId: string): string | undefined {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return undefined;
	for (const block of message.content) {
		if (!isRecord(block) || block.type !== "toolCall" || block.id !== toolCallId) continue;
		return isRecord(block.arguments) ? stringProperty(block.arguments, "op") : undefined;
	}
	return undefined;
}

function assistantText(message: AssistantMessage): string {
	return message.content
		.filter((content): content is TextContent => content.type === "text")
		.map(content => content.text)
		.join("\n")
		.trim();
}

function promptLine(line: string): PromptLine {
	const withoutMarkdownPrefix = line
		.trim()
		.replace(INLINE_EMPHASIS_RE, "$2")
		.replace(MARKDOWN_PROMPT_PREFIX_RE, "")
		.trim();
	const withoutPromptLabel = withoutMarkdownPrefix.replace(PROMPT_LABEL_RE, "").trim();
	const withoutEmphasis = withoutPromptLabel.replace(WRAPPED_EMPHASIS_RE, "$2").trim();
	return {
		text: withoutEmphasis,
		hadPromptLabel: withoutPromptLabel !== withoutMarkdownPrefix,
	};
}

function isQuestionPromptLine(line: string): boolean {
	const candidate = promptLine(line);
	if (!/[?？]\s*$/.test(candidate.text)) return false;
	return (
		candidate.hadPromptLabel ||
		QUESTION_PROMPT_RE.test(candidate.text) ||
		CHOICE_CONFIRMATION_RE.test(candidate.text) ||
		USER_DIRECTED_PROMPT_RE.test(candidate.text) ||
		NON_ASCII_TEXT_RE.test(candidate.text)
	);
}

function isResponseCueLine(line: string): boolean {
	const candidate = promptLine(line)
		.text.replace(/[.!?。！？]+$/, "")
		.replace(LEADING_CONNECTIVE_RE, "")
		.trim();
	return USER_RESPONSE_CUE_RE.test(candidate);
}

/**
 * How a closing span hands control back, strongest first: `cue` instructs the user
 * ("tell me…", "If you confirm, I'll…") and no later prose can answer it; `request`
 * asks outright (labelled, user-addressed, or non-English question) but the agent may
 * still answer it itself; `question` is only question-shaped ("What's next?") and may
 * be a heading.
 */
type ClosingAsk = "none" | "question" | "request" | "cue";

function askOf(span: string): ClosingAsk {
	if (isResponseCueLine(span)) return "cue";
	if (!isQuestionPromptLine(span)) return "none";
	const candidate = promptLine(span);
	return candidate.hadPromptLabel || ADDRESSEE_RE.test(candidate.text) || NON_ASCII_TEXT_RE.test(candidate.text)
		? "request"
		: "question";
}

/** The last two sentences of the prose lines closing `paragraph`; a list item ends the walk. */
function closingSentences(paragraph: string): string[] {
	const sentences: string[] = [];
	const lines = paragraph.split(/\r?\n/);
	for (let index = lines.length - 1; index >= 0 && sentences.length < 2; index--) {
		const line = lines[index].trim();
		if (OPTION_LINE_RE.test(line)) break;
		const lineSentences = line.split(SENTENCE_BREAK_RE).filter(Boolean);
		sentences.unshift(...lineSentences.slice(sentences.length - 2));
	}
	return sentences;
}

function closingAsk(paragraph: string): ClosingAsk {
	const lastLine = paragraph.slice(paragraph.lastIndexOf("\n") + 1).trim();
	const sentences = closingSentences(paragraph);
	const asks = [askOf(lastLine), ...sentences.slice(-1).map(askOf)];
	// No lexicon recognizes a non-English follow-up ("…? Отдельно скажите, …"), and none
	// recognizes a non-English self-answer either; an open request is the costlier miss.
	const foreignQuestion =
		sentences.length === 2 && NON_ASCII_TEXT_RE.test(sentences[0]) && isQuestionPromptLine(sentences[0]);
	if (asks.includes("cue")) return "cue";
	if (foreignQuestion || asks.includes("request")) return "request";
	return asks.includes("question") ? "question" : "none";
}

function isAwaitingUserAnswer(message: AssistantMessage): boolean {
	const text = assistantText(message);
	if (!text) return false;
	const paragraphs = text.split(/\r?\n\s*\r?\n/);
	const lastParagraph = paragraphs.at(-1)?.trim() ?? "";
	if (closingAsk(lastParagraph) !== "none") return true;
	// A one-line closing note ("Repository unchanged, no commits.") does not withdraw an
	// instruction in the paragraph before it. A question there may be self-answered by
	// that note ("Do you need…?\n\nNo, …"), so it does not count.
	const previousParagraph = paragraphs.at(-2)?.trim();
	if (
		previousParagraph &&
		!lastParagraph.includes("\n") &&
		!OPTION_LINE_RE.test(lastParagraph) &&
		closingAsk(previousParagraph) === "cue"
	) {
		return true;
	}
	const lines = text.split(/\r?\n/);

	// Options and a recommendation do not answer the question on the user's behalf.
	// Stop at other prose so self-answered questions still allow unfinished work to resume.
	let optionCount = 0;
	let hasRecommendation = false;
	for (let index = lines.length - 1; index >= 0; index--) {
		const line = lines[index].trim();
		if (!line) continue;
		if (OPTION_LINE_RE.test(line)) {
			optionCount++;
			continue;
		}
		const candidate = promptLine(line);
		if (optionCount > 0) {
			return (
				optionCount >= 2 &&
				isQuestionPromptLine(line) &&
				(hasRecommendation ||
					candidate.hadPromptLabel ||
					USER_DIRECTED_PROMPT_RE.test(candidate.text) ||
					CHOICE_CONFIRMATION_RE.test(candidate.text))
			);
		}
		if (RECOMMENDATION_RE.test(candidate.text)) {
			hasRecommendation = true;
			continue;
		}
		return false;
	}
	return false;
}
