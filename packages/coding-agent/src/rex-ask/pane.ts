import { isRecord, logger } from "@oh-my-pi/pi-utils";
import type {
	ExtensionAskDialogQuestion,
	ExtensionAskDialogResult,
	ExtensionUIDialogOptions,
} from "../extensibility/extensions/types";
import { componentPaneHost, type ComponentPane, type ComponentPaneHost } from "../rex-panes/component-pane";
import type { RexRunner } from "../rex-panes/rex-cli";
import { followActiveWindow, runPanelRex } from "../rex-panes/rex-focus";
import { AskFloat, type FloatAsk } from "./float";

interface Pending extends FloatAsk {
	settle(value: { result: ExtensionAskDialogResult | undefined } | undefined): void;
}
export interface AskPaneOptions {
	enabled(): boolean;
	waiting(waiting: boolean): void;
	host?: () => ComponentPaneHost | undefined;
	run?: RexRunner;
	follow?: typeof followActiveWindow;
}

const BOUNDS = [0.15, 0.12, 0.7, 0.76] as const;

export class AskPane {
	readonly #queue: Pending[] = [];
	#pane?: ComponentPane<never>;
	#component?: AskFloat;
	#opening?: Promise<void>;
	#watch?: { dispose(): void; failed?: Promise<void> };
	#sessionId = "";
	#windowId = "";
	#chain = Promise.resolve();
	#disposed = false;
	readonly #run: RexRunner;

	constructor(readonly options: AskPaneOptions) {
		this.#run = options.run ?? runPanelRex;
	}
	available(): boolean {
		return !this.#disposed && this.options.enabled() && !!(this.options.host ?? componentPaneHost)()?.mainLocation();
	}

	request(
		questions: ExtensionAskDialogQuestion[],
		options: ExtensionUIDialogOptions = {},
	): Promise<{ result: ExtensionAskDialogResult | undefined } | undefined> {
		if (!this.available()) return Promise.resolve(undefined);
		if (options.signal?.aborted) return Promise.resolve({ result: undefined });
		const result = Promise.withResolvers<{ result: ExtensionAskDialogResult | undefined } | undefined>();
		let settled = false;
		const abort = (): void => pending.finish(undefined);
		const pending: Pending = {
			questions,
			options,
			finish: answer => pending.settle({ result: answer }),
			settle: answer => {
				if (settled) return;
				settled = true;
				options.signal?.removeEventListener("abort", abort);
				const index = this.#queue.indexOf(pending);
				if (index >= 0) this.#queue.splice(index, 1);
				result.resolve(answer);
				this.#refresh();
			},
		};
		this.#queue.push(pending);
		options.signal?.addEventListener("abort", abort, { once: true });
		this.options.waiting(true);
		this.#refresh();
		return result.promise;
	}

	#refresh(): void {
		const first = this.#queue[0];
		if (!first) {
			this.options.waiting(false);
			this.#watch?.dispose();
			this.#watch = undefined;
			const pane = this.#pane;
			this.#pane = undefined;
			this.#component = undefined;
			if (pane) this.#chain = this.#chain.then(() => pane.close()).catch(error => this.#fail(error));
			return;
		}
		if (this.#pane && this.#component) {
			this.#component.show(first, this.#queue.length - 1);
			this.#chain = this.#chain.then(() => this.#raise()).catch(error => this.#fail(error));
		} else if (!this.#opening) {
			this.#opening = this.#open()
				.catch(error => this.#fail(error))
				.finally(() => {
					this.#opening = undefined;
					if (this.#queue.length && !this.#disposed) this.#refresh();
				});
		}
	}

	async #json(args: string[]): Promise<unknown> {
		const result = await this.#run(args, 10_000);
		if (result.exitCode !== 0) throw new Error("Rex ask pane request failed");
		return JSON.parse(result.stdout);
	}
	async #call(method: string, args: object): Promise<void> {
		await this.#json(["api", "call", "-s", this.#sessionId, method, JSON.stringify(args)]);
	}
	async #inspect(): Promise<Record<string, unknown>> {
		const snapshot = await this.#json(["session", "inspect", this.#sessionId, "--json"]);
		if (!isRecord(snapshot) || !Array.isArray(snapshot.windows)) throw new Error("Rex ask session unavailable");
		return snapshot;
	}
	async #open(): Promise<void> {
		await this.#chain;
		const host = (this.options.host ?? componentPaneHost)();
		const location = host?.mainLocation();
		if (!host || !location) throw new Error("Rex ask host unavailable");
		this.#sessionId = location.sessionId;
		const snapshot = await this.#inspect();
		if (typeof snapshot.active_window_id !== "string") throw new Error("Rex active tab unavailable");
		this.#windowId = snapshot.active_window_id;
		if (!this.#queue.length || this.#disposed) return;
		const pane = await host.open<never>(
			{ kind: "float", sessionId: this.#sessionId, windowId: this.#windowId, bounds: BOUNDS },
			"omp: ask",
			tui => {
				const component = new AskFloat(tui);
				this.#component = component;
				const first = this.#queue[0];
				if (first) component.show(first, this.#queue.length - 1);
				return component;
			},
		);
		if (!pane) throw new Error("Rex ask float could not open");
		if (this.#disposed || !this.#queue.length) {
			await pane.close();
			return;
		}
		this.#pane = pane;
		void pane.result.then(() => {
			if (this.#pane !== pane) return;
			this.#fail(new Error("Rex ask pane closed before an answer"));
		});
		this.#watch = (this.options.follow ?? followActiveWindow)(this.#sessionId, id => this.#follow(id));
		void this.#watch.failed?.then(() => this.#fail(new Error("Rex ask tab events unavailable")));
		// Subscribe before the second snapshot so a tab switch during open is not lost.
		const current = await this.#inspect();
		if (typeof current.active_window_id === "string" && current.active_window_id !== this.#windowId)
			this.#follow(current.active_window_id);
		await this.#raise();
	}
	#follow(windowId: string): void {
		if (!this.#pane || this.#disposed || windowId === this.#windowId) return;
		this.#windowId = windowId;
		this.#chain = this.#chain
			.then(async () => {
				const pane = this.#pane;
				if (!pane || windowId !== this.#windowId) return;
				const snapshot = await this.#inspect();
				const window = Array.isArray(snapshot.windows)
					? snapshot.windows.find(value => isRecord(value) && value.window_id === windowId)
					: undefined;
				const blocks =
					isRecord(window) && Array.isArray(window.layers)
						? window.layers.flatMap(layer => (isRecord(layer) && Array.isArray(layer.blocks) ? layer.blocks : []))
						: [];
				const anchor =
					blocks.find(
						block =>
							isRecord(block) && block.block_id === window?.focused_block_id && block.block_id !== pane.blockId,
					) ?? blocks.find(block => isRecord(block) && block.block_id !== pane.blockId);
				if (!isRecord(anchor) || typeof anchor.block_id !== "string")
					throw new Error("Rex ask tab anchor unavailable");
				await this.#call("session.move_block", {
					block_id: pane.blockId,
					anchor_block_id: anchor.block_id,
					direction: "horizontal",
					ratio: 0.5,
				});
				await this.#call("session.float_block", { block_id: pane.blockId, bounds: BOUNDS });
				await this.#raise();
			})
			.catch(error => this.#fail(error));
	}
	async #raise(): Promise<void> {
		const pane = this.#pane;
		if (!pane) return;
		const snapshot = await this.#inspect();
		if (this.#pane !== pane) return;
		const layers = Array.isArray(snapshot.windows)
			? snapshot.windows.flatMap(window => (isRecord(window) && Array.isArray(window.layers) ? window.layers : []))
			: [];
		const layer = layers.find(
			value =>
				isRecord(value) &&
				Array.isArray(value.blocks) &&
				value.blocks.some(block => isRecord(block) && block.block_id === pane.blockId),
		);
		if (!isRecord(layer) || typeof layer.layer_id !== "string") throw new Error("Rex ask layer unavailable");
		await this.#call("session.raise_layer", { layer_id: layer.layer_id });
	}
	async focus(): Promise<boolean> {
		await this.#opening;
		await this.#chain;
		if (!this.#pane) return false;
		await this.#raise();
		await this.#call("session.focus_block", { block_id: this.#pane.blockId });
		return true;
	}
	#fail(error: unknown): void {
		logger.warn("rex-ask: float unavailable; using inline dialog", { error: String(error) });
		while (this.#queue.length) this.#queue[0]!.settle(undefined);
	}
	async dispose(): Promise<void> {
		this.#disposed = true;
		while (this.#queue.length) this.#queue[0]!.finish(undefined);
		await this.#opening;
		await this.#chain;
	}
}
