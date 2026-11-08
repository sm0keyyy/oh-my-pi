import type { Settings } from "../config/settings";
import type {
	ExtensionAskDialogQuestion,
	ExtensionAskDialogResult,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
} from "../extensibility/extensions/types";
import { AskPane } from "./pane";
import { rexAskSettings } from "./settings";
import type { AskSource, OperatorAskAnswer, OperatorAskRequest } from "./types";
export * from "./types";

let current: { pane: AskPane; ui: ExtensionUIContext; source(): AskSource } | undefined;

export function startAskPane(input: { settings: Settings; ui: ExtensionUIContext; source(): AskSource }): {
	dispose(): Promise<void>;
} {
	const pane = new AskPane({
		enabled: () => rexAskSettings.float.get(input.settings),
		waiting: waiting =>
			input.ui.setWidget("rex-ask-wait", waiting ? ["Waiting on the operator (ask pane)"] : undefined),
	});
	const service = { pane, ui: input.ui, source: input.source };
	current = service;
	return {
		async dispose() {
			if (current === service) current = undefined;
			await pane.dispose();
		},
	};
}

export function askPaneAvailable(): boolean {
	return current?.pane.available() ?? false;
}
export async function focusAskPane(): Promise<boolean> {
	return (await current?.pane.focus()) ?? false;
}

export async function routeAskDialog(
	questions: ExtensionAskDialogQuestion[],
	options: ExtensionUIDialogOptions | undefined,
	inline: () => Promise<ExtensionAskDialogResult | undefined>,
): Promise<ExtensionAskDialogResult | undefined> {
	const service = current;
	if (!service) return inline();
	const answer = await service.pane.request(questions, {
		...options,
		source: { ...service.source(), ...options?.source },
	});
	return answer ? answer.result : options?.signal?.aborted ? undefined : inline();
}

export async function requestOperatorAsk(req: OperatorAskRequest): Promise<OperatorAskAnswer> {
	const ui = current?.ui;
	if (!ui) return { cancelled: true };
	if (ui.askDialog) {
		const result = await ui.askDialog([{ id: "operator", question: req.question, options: req.options ?? [] }], {
			source: req.source,
			context: req.context,
		});
		if (!result || result.kind !== "submit") return { cancelled: true };
		const answer = result.results[0];
		if (!answer) return { cancelled: true };
		return { answer: answer.customInput ?? answer.selectedOptions.join(", ") };
	}
	const answer = await ui.editor(req.question);
	return answer === undefined ? { cancelled: true } : { answer };
}
