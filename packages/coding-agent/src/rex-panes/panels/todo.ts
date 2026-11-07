import { type Component, type TUI } from "@oh-my-pi/pi-tui";
import { col, text } from "@oh-my-pi/pi-tui/native/describe";
import type { NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { formatMoreItems, truncateToWidth } from "@oh-my-pi/pi-tui/render/render-utils";
import { $which, logger, TempDir } from "@oh-my-pi/pi-utils";
import type { TodoHudView } from "../../modes/components/todo-hud";
import type { InteractiveMode } from "../../modes/interactive-mode";
import { markdownToPhases } from "../../tools/todo";
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
	const command = resolveEditorSpawnCommand(editor, file).cmd;
	if (process.env.PATH !== undefined) command.unshift("/usr/bin/env", `PATH=${process.env.PATH}`);
	const { blockId } = await rex.split(location.sessionId, location.blockId, "below", "omp: todo editor", command);
	let closing: Promise<void> | undefined;
	const close = (): Promise<void> => (closing ??= rex.closeBlock(location.sessionId, blockId));
	const abort = (): void => {
		void close().catch(error => logger.warn("rex-panels: todo editor close failed", { error: String(error) }));
	};
	options.signal.addEventListener("abort", abort, { once: true });
	try {
		let result: { exitCode: number } | undefined;
		if (!options.signal.aborted) {
			try {
				await rex.focusBlock(location.sessionId, blockId);
				if (!options.signal.aborted) result = await rex.waitBlock(location.sessionId, blockId, 24 * 60 * 60 * 1000);
			} catch (error) {
				if (!options.signal.aborted) throw error;
			}
		}
		if (options.signal.aborted) {
			await close().catch(() => {
				// The finally block logs close failures; saved work still needs recovery.
			});
			const saved = await Bun.file(file).text();
			if (saved === markdown) return null;
			const parsed = markdownToPhases(saved);
			return parsed.errors.length === 0 && parsed.phases.some(phase => phase.tasks.length > 0) ? saved : null;
		}
		return result?.exitCode === 0 ? await Bun.file(file).text() : null;
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
		const rows = Math.max(0, this.tui.terminal.rows);
		if (rows === 0) return [];
		const list = this.#view?.lines ?? ["No todos."];
		const listRows = rows - 1;
		const visibleRows = Math.max(0, listRows - 1);
		const visible =
			list.length > listRows
				? [
						...list.slice(0, visibleRows),
						...(listRows > 0 ? [formatMoreItems(list.length - visibleRows, "row")] : []),
					]
				: list;
		return [...visible, "e edit todos"].map(line => truncateToWidth(line, width));
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
