import { type Component, type TUI } from "@oh-my-pi/pi-tui";
import { col, text } from "@oh-my-pi/pi-tui/native/describe";
import type { NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { truncateToWidth } from "@oh-my-pi/pi-tui/render/render-utils";
import { $which, logger, TempDir } from "@oh-my-pi/pi-utils";
import type { TodoHudView } from "../../modes/components/todo-hud";
import type { InteractiveMode } from "../../modes/interactive-mode";
import { getEditorCommand, resolveEditorSpawnCommand } from "../../utils/external-editor";
import type { RexLocation } from "../component-pane";
import { createRexCli, type RexCli } from "../rex-cli";

export async function editTodoInRex(
	markdown: string,
	location: RexLocation,
	options: { signal: AbortSignal; rex?: RexCli; editorCommand?: string },
): Promise<string | null> {
	const editor = options.editorCommand ?? getEditorCommand();
	if (!editor) throw new Error("Set $VISUAL or $EDITOR to edit todos.");
	const binary = options.rex ? undefined : await $which("rex");
	if (!options.rex && !binary) throw new Error("rex is not on PATH");
	const rex = options.rex ?? createRexCli({ binary: binary! });
	await using temp = await TempDir.create("@rex-todo-");
	const file = temp.join("todos.todo.md");
	await Bun.write(file, markdown, { mode: 0o600 });
	if (options.signal.aborted) return null;
	const { blockId } = await rex.split(
		location.sessionId,
		location.blockId,
		"below",
		"omp: todo editor",
		resolveEditorSpawnCommand(editor, file).cmd,
	);
	let closing: Promise<void> | undefined;
	const close = (): Promise<void> => (closing ??= rex.closeBlock(location.sessionId, blockId));
	const abort = (): void => {
		void close().catch(error => logger.warn("rex-panels: todo editor close failed", { error: String(error) }));
	};
	options.signal.addEventListener("abort", abort, { once: true });
	try {
		if (options.signal.aborted) {
			await close();
			return null;
		}
		const result = await rex.waitBlock(location.sessionId, blockId, 24 * 60 * 60 * 1000);
		if (options.signal.aborted || result.exitCode !== 0) return null;
		return await Bun.file(file).text();
	} finally {
		options.signal.removeEventListener("abort", abort);
		await close().catch(error => logger.warn("rex-panels: todo editor close failed", { error: String(error) }));
	}
}

export class TodoPanel implements Component {
	#view: TodoHudView | undefined;
	readonly #unsubscribe: () => void;
	#editing = false;
	#disposed = false;

	constructor(
		readonly mode: InteractiveMode,
		readonly tui: TUI,
		readonly location: () => RexLocation,
		readonly signal: AbortSignal,
	) {
		this.#view = mode.todoHudView(true);
		this.#unsubscribe = mode.onTodoPanelChange(() => {
			this.#view = mode.todoHudView(true);
			tui.requestRender();
		});
	}

	render(width: number): readonly string[] {
		return [...(this.#view?.lines ?? ["No todos."]), "e edit todos"]
			.map(line => truncateToWidth(line, width))
			.slice(0, this.tui.terminal.rows);
	}

	describe(): NativeNode {
		return col([this.#view?.native.fallback ?? text("No todos."), text("e edit todos")]);
	}

	handleInput(data: string): void {
		if (data !== "e" || this.#editing || this.#disposed) return;
		this.#editing = true;
		void this.mode
			.editPanelTodos(markdown => editTodoInRex(markdown, this.location(), { signal: this.signal }))
			.catch(error => logger.warn("rex-panels: todo edit failed", { error: String(error) }))
			.finally(() => {
				this.#editing = false;
			});
	}

	invalidate(): void {}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#unsubscribe();
	}
}
