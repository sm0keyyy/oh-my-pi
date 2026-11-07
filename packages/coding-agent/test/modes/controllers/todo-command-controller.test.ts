import { afterEach, describe, expect, it, type Mock, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { TodoCommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/todo-command-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { type TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { USER_TODO_EDIT_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/tools";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import * as externalEditor from "../../../src/utils/external-editor";
import { createTodoBeadsFixture } from "../../helpers/todo-beads";
import { handleTodoAcp } from "../../../src/slash-commands/helpers/todo";
import type { SlashCommandRuntime } from "../../../src/slash-commands/types";

function createContext(cwd: string, phases: TodoPhase[]): InteractiveModeContext {
	return {
		agent: {
			appendMessage: vi.fn(),
		},
		session: {
			getTodoPhases: () => phases,
			setTodoPhases: vi.fn((next: TodoPhase[]) => {
				phases = next;
			}),
		},
		sessionManager: {
			appendCustomEntry: vi.fn(),
			appendMessage: vi.fn(),
			getBranch: () => [],
			getCwd: () => cwd,
		},
		ui: { stop: vi.fn(), start: vi.fn(), requestRender: vi.fn() },
		setTodos: vi.fn(),
		showError: vi.fn(),
		showStatus: vi.fn(),
		showWarning: vi.fn(),
	} as unknown as InteractiveModeContext;
}

describe("TodoCommandController", () => {
	let tempRoot = "";

	afterEach(async () => {
		vi.restoreAllMocks();
		if (tempRoot) await removeWithRetries(tempRoot);
		tempRoot = "";
	});

	it("exports the default TODO.md under the active session cwd", async () => {
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pi-tui-todo-export-"));
		const phases: TodoPhase[] = [{ name: "Work", tasks: [{ content: "Ship it", status: "pending" }] }];
		const ctx = createContext(tempRoot, phases);
		const controller = new TodoCommandController(ctx);

		await controller.handleTodoCommand("export");

		const target = path.join(tempRoot, "TODO.md");
		expect(await fs.readFile(target, "utf8")).toBe("# Work\n- [ ] Ship it\n");
		expect(ctx.showStatus).toHaveBeenCalledWith(`Wrote todos to ${target}`);
		expect(ctx.showError).not.toHaveBeenCalled();
	});

	it("exports a quoted path with spaces", async () => {
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pi-tui-todo-export-quoted-"));
		const phases: TodoPhase[] = [{ name: "Work", tasks: [{ content: "Ship it", status: "pending" }] }];
		const target = path.join(tempRoot, "todo file.md");
		const ctx = createContext(tempRoot, phases);
		const controller = new TodoCommandController(ctx);

		await controller.handleTodoCommand(`export "${target}"`);

		expect(await fs.readFile(target, "utf8")).toBe("# Work\n- [ ] Ship it\n");
		expect(ctx.showStatus).toHaveBeenCalledWith(`Wrote todos to ${target}`);
		expect(ctx.showError).not.toHaveBeenCalled();
	});

	it("imports the default TODO.md under the active session cwd", async () => {
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pi-tui-todo-import-"));
		const target = path.join(tempRoot, "TODO.md");
		await fs.writeFile(target, "# Imported\n- [ ] From cwd\n", "utf8");
		const ctx = createContext(tempRoot, []);
		const controller = new TodoCommandController(ctx);

		await controller.handleTodoCommand("import");

		const expected: TodoPhase[] = [{ name: "Imported", tasks: [{ content: "From cwd", status: "in_progress" }] }];
		expect(ctx.session.setTodoPhases).toHaveBeenCalledWith(expected);
		expect(ctx.setTodos).toHaveBeenCalledWith(expected);
		expect(ctx.sessionManager.appendCustomEntry).toHaveBeenCalledWith(USER_TODO_EDIT_CUSTOM_TYPE, {
			phases: expected,
		});
		expect(ctx.agent.appendMessage).toHaveBeenCalledWith(expect.objectContaining({ role: "developer" }));
		expect(ctx.sessionManager.appendMessage).toHaveBeenCalledWith(expect.objectContaining({ role: "developer" }));
		expect(ctx.showStatus).toHaveBeenCalledWith(`Imported 1 phase(s), 1 task(s) from ${target}.`);
		expect(ctx.showError).not.toHaveBeenCalled();
	});

	it("imports a quoted path with spaces", async () => {
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pi-tui-todo-import-quoted-"));
		const target = path.join(tempRoot, "todo file.md");
		await fs.writeFile(target, "# Quoted\n- [ ] From quoted path\n", "utf8");
		const ctx = createContext(tempRoot, []);
		const controller = new TodoCommandController(ctx);

		await controller.handleTodoCommand(`import "${target}"`);

		const expected: TodoPhase[] = [
			{ name: "Quoted", tasks: [{ content: "From quoted path", status: "in_progress" }] },
		];
		expect(ctx.session.setTodoPhases).toHaveBeenCalledWith(expected);
		expect(ctx.showStatus).toHaveBeenCalledWith(`Imported 1 phase(s), 1 task(s) from ${target}.`);
		expect(ctx.showError).not.toHaveBeenCalled();
	});

	it("reports import parse errors without committing", async () => {
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pi-tui-todo-import-invalid-"));
		const target = path.join(tempRoot, "TODO.md");
		await fs.writeFile(target, "# Imported\nnot a todo\n", "utf8");
		const ctx = createContext(tempRoot, []);
		const controller = new TodoCommandController(ctx);

		await controller.handleTodoCommand("import");

		expect(ctx.showError).toHaveBeenCalledWith(expect.stringContaining(`Could not parse ${target}:`));
		expect(ctx.session.setTodoPhases).not.toHaveBeenCalled();
		expect(ctx.setTodos).not.toHaveBeenCalled();
	});

	it("reports invalid internal-scheme import paths without committing", async () => {
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pi-tui-todo-import-scheme-"));
		const ctx = createContext(tempRoot, []);
		const controller = new TodoCommandController(ctx);

		await controller.handleTodoCommand("import artifact://todo");

		expect(ctx.showError).toHaveBeenCalledWith(expect.stringContaining("Failed to read todos:"));
		expect(ctx.showError).toHaveBeenCalledWith(expect.stringContaining("internal scheme"));
		expect(ctx.session.setTodoPhases).not.toHaveBeenCalled();
		expect(ctx.setTodos).not.toHaveBeenCalled();
	});

	it("reports invalid internal-scheme export paths", async () => {
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pi-tui-todo-export-invalid-"));
		const phases: TodoPhase[] = [{ name: "Work", tasks: [{ content: "Ship it", status: "pending" }] }];
		const ctx = createContext(tempRoot, phases);
		const controller = new TodoCommandController(ctx);

		await controller.handleTodoCommand("export artifact://todo");

		expect(ctx.showError).toHaveBeenCalledWith(expect.stringContaining("Failed to write todos:"));
		expect(ctx.showError).toHaveBeenCalledWith(expect.stringContaining("internal scheme"));
	});

	function reminderTextFrom(ctx: InteractiveModeContext): string {
		const appendMessage = ctx.agent.appendMessage as unknown as Mock<(message: unknown) => void>;
		const message = appendMessage.mock.calls[0][0] as { content: Array<{ text: string }> };
		return message.content[0].text;
	}

	it("tells the model not to recreate the list after /todo rm (all)", async () => {
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pi-tui-todo-rm-all-"));
		const phases: TodoPhase[] = [
			{ name: "Foundation", tasks: [{ content: "Scaffold crate", status: "in_progress" }] },
		];
		const ctx = createContext(tempRoot, phases);
		const controller = new TodoCommandController(ctx);

		await controller.handleTodoCommand("rm");

		expect(ctx.agent.appendMessage).toHaveBeenCalledTimes(1);
		const text = reminderTextFrom(ctx);
		expect(text).toContain("intentionally cleared the todo list");
		expect(text).toMatch(/Do NOT recreate/i);
	});

	it("tells the model not to re-add a removed phase after /todo rm <phase>", async () => {
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pi-tui-todo-rm-phase-"));
		const phases: TodoPhase[] = [
			{ name: "Foundation", tasks: [{ content: "Scaffold crate", status: "completed" }] },
			{ name: "Auth", tasks: [{ content: "Port credential store", status: "pending" }] },
		];
		const ctx = createContext(tempRoot, phases);
		const controller = new TodoCommandController(ctx);

		await controller.handleTodoCommand("rm Auth");

		expect(reminderTextFrom(ctx)).toMatch(/Do NOT re-add them/i);
	});

	it("keeps status-mutation reminders neutral (no do-not-recreate directive)", async () => {
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pi-tui-todo-done-"));
		const phases: TodoPhase[] = [
			{ name: "Foundation", tasks: [{ content: "Scaffold crate", status: "in_progress" }] },
		];
		const ctx = createContext(tempRoot, phases);
		const controller = new TodoCommandController(ctx);

		await controller.handleTodoCommand("done");

		expect(reminderTextFrom(ctx)).not.toMatch(/Do NOT/i);
	});

	it("F6 retains a rejected editor buffer for the next edit without a commit", async () => {
		const initial: TodoPhase[] = [
			{ id: "omp-epic01", name: "Build", tasks: [{ id: "omp-epic01.1", content: "A", status: "pending" }] },
		];
		const invalid =
			"# Build <!-- bead: omp-epic01 -->\n- [ ] A <!-- bead: omp-epic01.1 -->\n- [ ] Copied task <!-- bead: omp-epic01.1 -->";
		const ctx = createContext("/tmp/todo-editor-fixture", initial);
		vi.spyOn(externalEditor, "getEditorCommand").mockReturnValue("fixture-editor");
		const editor = vi
			.spyOn(externalEditor, "openInEditor")
			.mockResolvedValueOnce(invalid)
			.mockResolvedValueOnce(null);
		const controller = new TodoCommandController(ctx);
		await controller.handleTodoCommand("edit");
		expect(ctx.session.setTodoPhases).not.toHaveBeenCalled();
		expect(ctx.showError).toHaveBeenCalledWith(expect.stringContaining("Line 3"));
		await controller.handleTodoCommand("edit");
		expect(editor.mock.calls[1]?.[1]).toBe(invalid);
	});

	for (const mode of ["tui", "acp"] as const) {
		it(`F7 persists assigned IDs immediately after a ${mode} todo edit`, async () => {
			const f = await createTodoBeadsFixture();
			try {
				const ctx = createContext(f.root, []);
				vi.spyOn(ctx.session, "getTodoPhases").mockImplementation(() => f.tracker.phases);
				vi.spyOn(ctx.session, "setTodoPhases").mockImplementation(next => f.tracker.commit(next));
				vi.spyOn(ctx.sessionManager, "appendCustomEntry").mockImplementation((kind, data) =>
					f.manager.appendCustomEntry(kind, data),
				);
				vi.spyOn(ctx.sessionManager, "getBranch").mockImplementation(() => f.manager.getBranch());
				if (mode === "tui") {
					await new TodoCommandController(ctx).handleTodoCommand("append Build A");
				} else {
					const runtime: SlashCommandRuntime = {
						session: ctx.session,
						sessionManager: f.manager,
						settings: f.settings,
						cwd: f.root,
						output: () => {},
						refreshCommands: () => {},
						reloadPlugins: async () => {},
					};
					await handleTodoAcp({ name: "todo", args: "append Build A", text: "/todo append Build A" }, runtime);
				}
				const first = f.manager
					.getBranch()
					.find(entry => entry.type === "custom" && entry.customType === USER_TODO_EDIT_CUSTOM_TYPE);
				expect(first).toMatchObject({ data: { phases: f.tracker.phases } });
				expect(f.tracker.phases[0]!.id).toBeDefined();
				expect(f.tracker.phases[0]!.tasks[0]!.id).toBeDefined();
			} finally {
				await f.cleanup();
			}
		});
	}
});
