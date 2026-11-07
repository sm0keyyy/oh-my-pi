import { afterEach, beforeAll, expect, test, vi } from "bun:test";
import { $ } from "bun";
import { type Component, TUI } from "@oh-my-pi/pi-tui";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { AnnotationOverlay } from "@oh-my-pi/pi-tui/overlays/annotation-overlay";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { logger } from "@oh-my-pi/pi-utils";
import type { ExtensionUIContext } from "../../src/extensibility/extensions/types";
import {
	type ComponentPaneHost,
	type PaneComponentFactory,
	type PanePlacement,
	registerComponentPaneHost,
} from "../../src/rex-panes/component-pane";
import { startDiffReview } from "../../src/rex-review/diff-review";
import { cfgRexDiffReviewPane } from "../../src/rex-review/settings";
import type { AgentSessionEvent, AgentSessionEventListener } from "../../src/session/agent-session";
import * as externalEditor from "../../src/utils/external-editor";
import { assistantMsg, createTestSession } from "../utilities";
import { createPaneSessionFixture } from "../helpers/interactive-mode-context";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal";

const cleanup: Array<() => void | Promise<void>> = [];
beforeAll(() => initTheme());
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
	vi.restoreAllMocks();
});

async function harness() {
	const fixture = await createTestSession({
		settingsOverrides: { "compaction.enabled": false, "retry.enabled": false },
	});
	cleanup.push(fixture.cleanup);
	const cwd = fixture.tempDir;
	await Bun.write(`${cwd}/first.ts`, "const first = 1;\n");
	await Bun.write(`${cwd}/second.ts`, "const second = 1;\n");
	await $`git init -q ${cwd}`.quiet();
	await $`git -C ${cwd} add first.ts second.ts`.quiet();
	await $`git -C ${cwd} -c user.name=Test -c user.email=test@example.invalid commit -qm fixture`.quiet();
	await Bun.write(`${cwd}/first.ts`, "const first = 2;\n");
	await Bun.write(`${cwd}/second.ts`, "const second = 2;\n");
	const opened: Array<{ placement: PanePlacement; label: string; component: Component; close(): Promise<void> }> = [];
	const mounted: PromiseWithResolvers<void>[] = [];
	const host: ComponentPaneHost = {
		async open<T>(
			placement: PanePlacement,
			label: string,
			factory: PaneComponentFactory<T>,
			options?: { signal?: AbortSignal },
		) {
			const answer = Promise.withResolvers<T | undefined>();
			const tui = new TUI(new VirtualTerminal(120, 30), false, { embedded: true });
			const component = await factory(tui, theme, KeybindingsManager.inMemory(), answer.resolve);
			const close = async () => {
				answer.resolve(undefined);
				component.dispose?.();
			};
			options?.signal?.addEventListener("abort", () => void close(), { once: true });
			opened.push({ placement, label, component, close });
			mounted[opened.length - 1] ??= Promise.withResolvers<void>();
			mounted[opened.length - 1]!.resolve();
			return { blockId: `block:diff-${opened.length}`, result: answer.promise, close, requestRender() {} };
		},
		mainLocation: () => ({ sessionId: "session:main", blockId: "block:main" }),
		agentLocation: () => undefined,
		revealAgent: async () => false,
	};
	cleanup.push(registerComponentPaneHost(host));
	const paste = vi.fn((_text: string) => {});
	const prompt = vi.spyOn(fixture.session, "prompt").mockResolvedValue(true);
	const ui = { pasteToEditor: paste, notify: vi.fn() } as unknown as ExtensionUIContext;
	const subscribe = vi.spyOn(fixture.session, "subscribe");
	const service = startDiffReview({ settings: fixture.session.settings, cwd, session: fixture.session, ui });
	cleanup.push(service.dispose);
	const listener: AgentSessionEventListener = subscribe.mock.calls.at(-1)![0];
	const pending: Promise<void>[] = [];
	const emit = (event: AgentSessionEvent) => {
		const result = Promise.resolve(listener(event));
		pending.push(result);
		return result;
	};
	const end = (stopReason: "stop" | "aborted" | "error" = "stop") => {
		emit({ type: "agent_start" });
		return emit({ type: "agent_end", isTerminal: true, messages: [{ ...assistantMsg("Finished"), stopReason }] });
	};
	return {
		...fixture,
		opened,
		paste,
		prompt,
		emit,
		end,
		service,
		settle: () => Promise.all(pending.splice(0)),
		mounted(index: number) {
			mounted[index] ??= Promise.withResolvers<void>();
			return mounted[index]!.promise;
		},
	};
}

function addNote(component: Component, text: string): void {
	component.handleInput?.("a");
	component.handleInput?.(text);
	component.handleInput?.("\r");
}

test("trigger opens only changed, settled main diffs and never replaces an open frozen pane", async () => {
	const h = await harness();
	h.end();
	await h.mounted(0);
	expect(h.opened[0]!.placement).toEqual({
		kind: "dock",
		sessionId: "session:main",
		anchorBlockId: "block:main",
		direction: "right",
	});
	expect(h.opened[0]!.label).toBe("omp: diff");
	await Bun.write(`${h.tempDir}/first.ts`, "const first = 3;\n");
	await h.end();
	expect(h.opened).toHaveLength(1);
	await h.opened[0]!.close();
	await h.settle();
	h.end();
	await h.mounted(1);
	await h.opened[1]!.close();
	await h.settle();
	await h.end();
	expect(h.opened).toHaveLength(2);
	await Bun.write(`${h.tempDir}/first.ts`, "const first = 4;\n");
	for (const reason of ["aborted", "error"] as const) await h.end(reason);
	expect(h.opened).toHaveLength(2);
	cfgRexDiffReviewPane.set(h.session.settings, false);
	await h.end();
	expect(h.opened).toHaveLength(2);
	cfgRexDiffReviewPane.set(h.session.settings, true);
	const child = createPaneSessionFixture();
	cleanup.push(child.close);
	const turn = child.session.prompt("Finish the child turn.");
	child.stream.push({
		type: "done",
		reason: "stop",
		message: { ...child.partial, content: [{ type: "text", text: "Child finished" }] },
	});
	await turn;
	expect(h.opened).toHaveLength(2);
	await Bun.write(`${h.tempDir}/first.ts`, "const first = 1;\n");
	await Bun.write(`${h.tempDir}/second.ts`, "const second = 1;\n");
	await h.end();
	expect(h.opened).toHaveLength(2);
	expect(h.paste).not.toHaveBeenCalled();
	expect(h.prompt).not.toHaveBeenCalled();
});

test("send batches two line notes until paste, keeps Enter as the main submit gate, and disables terminal editors", async () => {
	const h = await harness();
	const external = vi.spyOn(externalEditor, "openInEditor");
	const sourceEditor = vi.spyOn(externalEditor, "openEditorOnPath");
	const stop = vi.spyOn(TUI.prototype, "stop");
	h.end();
	await h.mounted(0);
	const overlay = h.opened[0]!.component;
	expect(overlay).toBeInstanceOf(AnnotationOverlay);
	overlay.render(120);
	overlay.handleInput?.("\x1b[C");
	overlay.handleInput?.("\x05");
	overlay.handleInput?.("a");
	overlay.handleInput?.("\x05");
	overlay.handleInput?.("First line needs a guard");
	overlay.handleInput?.("\r");
	overlay.handleInput?.("]");
	addNote(overlay, "Second line needs a test");
	expect((overlay as AnnotationOverlay).getAnnotations()).toHaveLength(2);
	expect(h.paste).not.toHaveBeenCalled();
	expect(h.prompt).not.toHaveBeenCalled();
	overlay.handleInput?.("\t");
	overlay.handleInput?.("\r");
	await h.settle();
	const text = h.paste.mock.calls[0]![0];
	expect(text).toContain("first.ts");
	expect(text).toContain("second.ts");
	expect(text).toContain("old 1");
	expect(text).toContain("First line needs a guard");
	expect(text).toContain("Second line needs a test");
	expect(h.prompt).not.toHaveBeenCalled();
	expect(external).not.toHaveBeenCalled();
	expect(sourceEditor).not.toHaveBeenCalled();
	expect(stop).not.toHaveBeenCalled();
});

test("send review submits the frozen review prompt only to the main owning session as a follow-up", async () => {
	const h = await harness();
	h.end();
	await h.mounted(0);
	const overlay = h.opened[0]!.component;
	overlay.render(120);
	overlay.handleInput?.("\x1b[C");
	addNote(overlay, "Check this branch");
	expect(h.prompt).not.toHaveBeenCalled();
	overlay.handleInput?.("\t");
	overlay.handleInput?.("\x1b[A");
	overlay.handleInput?.("\r");
	await h.settle();
	expect(h.prompt.mock.calls[0]![0]).toContain("Check this branch");
	expect(h.prompt.mock.calls[0]![0]).toContain("const first = 2;");
	expect(h.prompt.mock.calls[0]![1]).toEqual({ streamingBehavior: "followUp" });
	expect(h.paste).not.toHaveBeenCalled();
});

test("trigger cancels stale session panes and makes a failed feature inert with one warning", async () => {
	const h = await harness();
	h.end();
	await h.mounted(0);
	await h.session.newSession();
	await h.settle();
	const old = h.opened[0]!.component;
	old.handleInput?.("\r");
	expect(h.paste).not.toHaveBeenCalled();
	expect(h.prompt).not.toHaveBeenCalled();
	const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
	vi.spyOn(h.session, "waitForIdle").mockRejectedValue(new Error("settle failure"));
	await h.end();
	await h.end();
	expect(warn.mock.calls[0]![0]).toStartWith("rex-review:");
	expect(warn).toHaveBeenCalledTimes(1);
	expect(h.opened).toHaveLength(1);
});
