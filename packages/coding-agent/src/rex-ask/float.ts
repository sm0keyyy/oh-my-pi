import { Container, Text, type Component, type TUI } from "@oh-my-pi/pi-tui";
import {
	AskDialogComponent,
	type ExtensionAskDialogQuestion,
	type ExtensionAskDialogResult,
	type AskDialogPromptValue,
} from "@oh-my-pi/pi-tui/overlays/ask-dialog";
import { sanitizeDisplaySingleLine } from "@oh-my-pi/pi-tui/overlays/extensions/display-text";
import { HookEditorComponent } from "@oh-my-pi/pi-tui/overlays/hook-editor";
import type { ExtensionUIDialogOptions } from "../extensibility/extensions/types";
import type { AskSource } from "./types";

export interface FloatAsk {
	questions: ExtensionAskDialogQuestion[];
	options: ExtensionUIDialogOptions;
	finish(result: ExtensionAskDialogResult | undefined): void;
}

export class AskFloat extends Container {
	#active?: FloatAsk;
	#dialog?: AskDialogComponent;
	#editor?: HookEditorComponent;
	#prompt?: (value: AskDialogPromptValue | undefined) => void;
	#input?: Component;
	#waiting = 0;

	constructor(readonly tui: TUI) {
		super();
	}

	show(ask: FloatAsk, waiting: number): void {
		this.#waiting = waiting;
		if (this.#active !== ask) {
			this.#release();
			this.#active = ask;
			this.#dialog = new AskDialogComponent(
				ask.questions,
				{
					onSubmit: result => ask.finish(result),
					onCancel: () => ask.finish(undefined),
					onPrompt: async (prompt, prefill) =>
						(await this.#openPrompt(prompt.title, prompt.question, prefill))?.text,
					onImagePrompt: ask.options.acceptImages
						? (prompt, prefill) => this.#openPrompt(prompt.title, prompt.question, prefill?.text, prefill)
						: undefined,
				},
				{ tui: this.tui, timeout: ask.options.timeout, onTimeout: ask.options.onTimeout },
			);
			this.#input = this.#dialog;
			ask.options.onTimeoutStart?.();
		}
		this.#mount();
	}

	#mount(): void {
		this.clear();
		const source: AskSource | undefined = this.#active?.options.source;
		const identity = [source?.agent ?? "Main", source?.role, source?.sessionLabel ?? source?.sessionId]
			.filter(Boolean)
			.join(" · ");
		this.addChild(new Text(sanitizeDisplaySingleLine(identity), 0, 0));
		if (this.#active?.options.context)
			this.addChild(new Text(sanitizeDisplaySingleLine(this.#active.options.context), 0, 0));
		this.addChild(new Text(`${this.#waiting} more waiting`, 0, 0));
		if (this.#input) this.addChild(this.#input);
		this.tui.requestRender();
	}

	#openPrompt(
		title: string,
		question: string,
		prefill?: string,
		value?: AskDialogPromptValue,
	): Promise<AskDialogPromptValue | undefined> {
		const result = Promise.withResolvers<AskDialogPromptValue | undefined>();
		this.#prompt = result.resolve;
		const finish = (answer: AskDialogPromptValue | undefined): void => {
			this.#prompt = undefined;
			this.#editor?.dispose();
			this.#editor = undefined;
			this.#input = this.#dialog;
			result.resolve(answer);
			queueMicrotask(() => this.#mount());
		};
		this.#editor = new HookEditorComponent(
			this.tui,
			title,
			prefill,
			(text, images) => finish({ text, images }),
			() => finish(undefined),
			{ promptStyle: true, question, acceptImages: this.#active?.options.acceptImages, images: value?.images },
		);
		this.#input = this.#editor;
		this.#mount();
		return result.promise;
	}

	handleInput(data: string): void {
		this.#input?.handleInput?.(data);
	}
	#release(): void {
		this.#dialog?.dispose();
		this.#editor?.dispose();
		this.#prompt?.(undefined);
		this.#prompt = undefined;
		this.#editor = undefined;
		this.#dialog = undefined;
		this.#input = undefined;
	}
	override dispose(): void {
		this.#release();
		this.#active = undefined;
		this.clear();
	}
}
