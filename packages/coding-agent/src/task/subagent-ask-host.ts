import { logger } from "@oh-my-pi/pi-utils";
import type {
	ExtensionAskDialogQuestion,
	ExtensionAskDialogResult,
	ExtensionUIDialogOptions,
	ExtensionUIContext,
} from "../extensibility/extensions/types";
import type { EventBus } from "../utils/event-bus";

export const SUBAGENT_ASK_TIMEOUT_MS = 600_000;

export interface SubagentAskHostOptions {
	main: ExtensionUIContext;
	subagentEventBus: EventBus;
	mirror?: (agentId: string) => ExtensionUIContext | undefined;
}

export interface SubagentAskHost {
	readonly subagentEventBus: EventBus;
	/** Source identity need not belong to a live session; external ask sources can use the same queue. */
	uiFor(agentId: string, displayName: string): ExtensionUIContext;
	mirrorAvailable(agentId: string): void;
	dispose(): void;
}

interface PendingAsk {
	agentId: string;
	start(): void;
	mirror(): void;
	cancel(): void;
}

const hosts = new WeakMap<EventBus, SubagentAskHost>();

export function registerSubagentAskHost(options: SubagentAskHostOptions): SubagentAskHost {
	hosts.get(options.subagentEventBus)?.dispose();
	const host = new AskHost(options);
	hosts.set(options.subagentEventBus, host);
	return host;
}

export function unregisterSubagentAskHost(host: SubagentAskHost): void {
	if (hosts.get(host.subagentEventBus) === host) hosts.delete(host.subagentEventBus);
	host.dispose();
}

export function subagentAskHostFor(bus: EventBus | undefined): SubagentAskHost | undefined {
	return bus ? hosts.get(bus) : undefined;
}

class AskHost implements SubagentAskHost {
	readonly subagentEventBus: EventBus;
	readonly #queue: PendingAsk[] = [];
	#active: PendingAsk | undefined;
	#disposed = false;

	constructor(private readonly options: SubagentAskHostOptions) {
		this.subagentEventBus = options.subagentEventBus;
	}

	uiFor(agentId: string, displayName: string): ExtensionUIContext {
		const main = this.options.main;
		return {
			select: async () => undefined,
			confirm: async () => false,
			input: async () => undefined,
			notify: () => {},
			onTerminalInput: () => () => {},
			rerenderMessage: () => {},
			getLinkClicksAvailable: () => false,
			setStatus: () => {},
			setWorkingMessage: () => {},
			setWidget: () => {},
			setFooter: () => {},
			setHeader: () => {},
			setTitle: () => {},
			custom: async () => undefined as never,
			setEditorText: () => {},
			pasteToEditor: () => {},
			getEditorText: () => "",
			editor: async () => undefined,
			addAutocompleteProvider: () => {},
			setEditorComponent: () => {},
			getEditorComponent: () => undefined,
			get theme() {
				return main.theme;
			},
			getAllThemes: async () => [],
			getTheme: async () => undefined,
			setTheme: async () => ({ success: false, error: "UI not available" }),
			getToolsExpanded: () => false,
			setToolsExpanded: () => {},
			timeoutStartsOnPresentation: true,
			askDialog: (questions, dialogOptions) =>
				this.#enqueue(
					agentId,
					questions.map(question => ({
						...question,
						question: `${displayName}: ${question.question}`,
						header: question.header ? `${displayName}: ${question.header}` : displayName,
					})),
					dialogOptions,
				),
		};
	}

	mirrorAvailable(agentId: string): void {
		if (this.#active?.agentId === agentId) this.#active.mirror();
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		if (hosts.get(this.subagentEventBus) === this) hosts.delete(this.subagentEventBus);
		this.#active?.cancel();
		for (const request of this.#queue.splice(0)) request.cancel();
	}

	#advance(): void {
		if (this.#disposed || this.#active) return;
		const next = this.#queue.shift();
		this.#active = next;
		next?.start();
	}

	#enqueue(
		agentId: string,
		questions: ExtensionAskDialogQuestion[],
		dialogOptions?: ExtensionUIDialogOptions,
	): Promise<ExtensionAskDialogResult | undefined> {
		if (this.#disposed || dialogOptions?.signal?.aborted) return Promise.resolve(undefined);
		const { promise, resolve, reject } = Promise.withResolvers<ExtensionAskDialogResult | undefined>();
		const controller = new AbortController();
		let settled = false;
		let presented = false;
		let mirrorUi: ExtensionUIContext | undefined;
		let mirrorController: AbortController | undefined;
		let timer: NodeJS.Timeout | undefined;

		const cleanup = (): void => {
			settled = true;
			clearTimeout(timer);
			dialogOptions?.signal?.removeEventListener("abort", onAbort);
			controller.abort();
			if (this.#active === request) this.#active = undefined;
			else {
				const index = this.#queue.indexOf(request);
				if (index >= 0) this.#queue.splice(index, 1);
			}
		};
		const finish = (result: ExtensionAskDialogResult | undefined): void => {
			if (settled) return;
			cleanup();
			resolve(result);
			this.#advance();
		};
		const fail = (error: unknown): void => {
			if (settled) return;
			cleanup();
			reject(error);
			this.#advance();
		};
		const onAbort = (): void => finish(undefined);
		const mirror = (): void => {
			if (settled || !presented) return;
			try {
				const ui = this.options.mirror?.(agentId);
				if (ui === mirrorUi) return;
				const previousController = mirrorController;
				mirrorUi = ui;
				mirrorController = undefined;
				previousController?.abort();
				if (!ui?.askDialog) return;
				const abort = new AbortController();
				mirrorController = abort;
				const signal = AbortSignal.any([controller.signal, abort.signal]);
				void ui.askDialog(questions, { signal, acceptImages: dialogOptions?.acceptImages }).then(
					result => {
						if (mirrorUi !== ui || mirrorController !== abort || signal.aborted) return;
						// Pane teardown resolves undefined too; only a current pane's Esc is an answer.
						if (result === undefined && this.options.mirror?.(agentId) !== ui) return;
						finish(result);
					},
					error => {
						// A pane failure must leave the main dialog available.
						if (!settled && !signal.aborted) {
							logger.warn("rex-panes: ask mirror failed", { agentId, error: String(error) });
						}
					},
				);
			} catch (error) {
				logger.warn("rex-panes: ask mirror failed", { agentId, error: String(error) });
			}
		};
		const onPresented = (): void => {
			if (settled || presented) return;
			presented = true;
			// The deadline is fixed from main presentation, not reset by typing or pane opens.
			timer = setTimeout(() => {
				dialogOptions?.onTimeout?.();
				finish({
					kind: "submit",
					results: questions.map(question => {
						const recommended =
							question.recommended !== undefined && Number.isInteger(question.recommended)
								? question.options[question.recommended]
								: undefined;
						return {
							id: question.id,
							question: question.question,
							options: question.options.map(option => option.label),
							multi: question.multi ?? false,
							selectedOptions: recommended ? [recommended.label] : [],
							timedOut: true,
						};
					}),
				});
			}, SUBAGENT_ASK_TIMEOUT_MS);
			dialogOptions?.onTimeoutStart?.();
			mirror();
		};
		const request: PendingAsk = {
			agentId,
			mirror,
			cancel: onAbort,
			start: () => {
				try {
					const main = this.options.main;
					if (!main.askDialog) throw new Error("Subagent ask host requires a main ask dialog");
					// Main owns presentation ordering against all other interactive dialogs.
					// Its resettable timeout is disabled; this host owns the fixed deadline.
					void main
						.askDialog(questions, {
							signal: controller.signal,
							acceptImages: dialogOptions?.acceptImages,
							onTimeoutStart: onPresented,
						})
						.then(finish, fail);
					if (!main.timeoutStartsOnPresentation) onPresented();
				} catch (error) {
					fail(error);
				}
			},
		};
		dialogOptions?.signal?.addEventListener("abort", onAbort, { once: true });
		this.#queue.push(request);
		this.#advance();
		return promise;
	}
}
