import { expect, test } from "bun:test";
import { runbookLines } from "@oh-my-pi/pi-tui/tools/runbook";
import { extensionLinkLabels, setExtensionLinks } from "@oh-my-pi/pi-tui/render/extension-links";
import { RunbookTool } from "../../src/runbook/tool";
import {
	activateRunbookLink,
	registerRunbookSession,
	runRunbook,
	RUNBOOK_LINK_SCHEME,
} from "../../src/runbook/registry";
import { rebuildRunbooks } from "../../src/runbook/entries";
import { BUILTIN_TOOLS } from "../../src/tools";
import { routePaneInput } from "../../src/rex-panes/pane-input";
import { fixture } from "./fixture";
import { SessionManager } from "../../src/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Markdown } from "@oh-my-pi/pi-tui/components/markdown";
import { getMarkdownTheme, initTheme } from "@oh-my-pi/pi-tui/theme";

test("pick routes only a valid owner link and rejects forged ids, steps and duplicate running picks", async () => {
	const gate = Promise.withResolvers<{ exitCode: number; output: string }>();
	const f = fixture({ local: async () => gate.promise });
	try {
		const result = await new RunbookTool(f.session).execute("pick", {
			title: "Deploy",
			steps: [{ title: "Ship", command: "echo approved" }],
		});
		f.save(result.details!);
		const id = result.details!.runbookId;
		setExtensionLinks([RUNBOOK_LINK_SCHEME]);
		const labels = runbookLines(result.details!).flatMap(line => extensionLinkLabels(line));
		const link = labels.find(label => label.url.startsWith(`omp-runbook:${id}/1#`))?.url;
		if (!link) throw new Error("Runbook renderer returned no step link");
		const nonce = link.split("#")[1]!;
		expect(JSON.stringify(result)).not.toContain(nonce);
		for (const forged of [
			link.replace(id, "unknown"),
			link.replace("/1#", "/2#"),
			link.replace("/1#", "/0#"),
			link.replace("/1#", "/1?command=bad#"),
			link.split("#")[0]!,
			link.replace(nonce, "00000000-0000-0000-0000-000000000000"),
		])
			expect((await activateRunbookLink(forged, f.journal.getSessionId())).ok).toBe(false);
		expect((await activateRunbookLink(link, "other-session")).ok).toBe(false);
		expect(f.jobs.getAllJobs()).toHaveLength(0);
		expect((await activateRunbookLink(link, f.journal.getSessionId())).ok).toBe(true);
		expect(await runRunbook(id, "all", "rpc")).toEqual({ ok: false, reason: "running" });
		gate.resolve({ exitCode: 0, output: "approved" });
		await f.settle();
		expect(f.deliveries).toHaveLength(1);
	} finally {
		gate.resolve({ exitCode: 0, output: "approved" });
		await f.close();
		setExtensionLinks([]);
	}
});

test("runbook-run entries restore the output block and operator pane fallback runs the latest owned book", async () => {
	await using temp = await TempDir.create("runbook-resume-");
	const journal = SessionManager.create(temp.path(), temp.join("sessions"));
	const f = fixture({ local: async () => ({ exitCode: 2, output: "restored failure" }) }, journal);
	const result = await new RunbookTool(f.session).execute("resume", {
		title: "Resume",
		steps: [{ title: "Step", command: "ignored" }],
	});
	f.save(result.details!, true);
	await runRunbook(result.details!.runbookId, 1, "tui");
	await f.settle();
	await journal.ensureOnDisk();
	await f.close();
	const resumedJournal = await SessionManager.open(journal.getSessionFile()!);
	const resumed = fixture({ local: async () => ({ exitCode: 0, output: "rerun" }) }, resumedJournal);
	try {
		new RunbookTool(resumed.session);
		expect(runbookLines(result.details!).join("\n")).toContain("Step · mac · exit 2");
		expect(runbookLines(result.details!).join("\n")).toContain("restored failure");
		expect(rebuildRunbooks(resumedJournal.getBranch()).get(result.details!.runbookId)?.runs).toMatchObject([
			{ n: 1, exitCode: 2, tail: "restored failure" },
		]);
		expect((await routePaneInput(resumed.agentId, "/run all")).kind).toBe("runbook");
		await resumed.settle();
		expect(resumed.deliveries[0]).toContain("rerun");
	} finally {
		await resumed.close();
		await resumedJournal.close();
		await journal.close();
	}
	expect(await runRunbook(result.details!.runbookId, 1, "rpc")).toEqual({ ok: false, reason: "unknown-runbook" });
});

test("headless and RPC-only sessions have no registered runbook even with advertised headless ask", async () => {
	const f = fixture();
	const subSession = { ...f.session, hasUI: false, canPromptUser: true, taskDepth: 1, tuiTranscript: false };
	try {
		expect(
			BUILTIN_TOOLS.runbook({ ...f.session, hasUI: false, canPromptUser: false, advertiseHeadlessAsk: true }),
		).toBeNull();
		expect(
			BUILTIN_TOOLS.runbook({ ...f.session, hasUI: true, canPromptUser: true, tuiTranscript: false }),
		).toBeNull();
		expect(
			BUILTIN_TOOLS.runbook({ ...f.session, getSessionId: () => `${f.journal.getSessionId()}-advisor` }),
		).toBeNull();
		const sub = await BUILTIN_TOOLS.runbook(subSession);
		expect(sub?.name).toBe("runbook");
	} finally {
		await registerRunbookSession(subSession).dispose();
		await f.close();
	}
});

test("session adoption retires old Run links and the same tool can publish in the new session", async () => {
	const f = fixture({ local: async () => ({ exitCode: 0, output: "new session" }) });
	try {
		const tool = new RunbookTool(f.session);
		const first = await tool.execute("old", { title: "Old", steps: [{ title: "Old", command: "old" }] });
		f.save(first.details!);
		f.adopt(SessionManager.inMemory(process.cwd()));
		expect((await runRunbook(first.details!.runbookId, 1, "tui")).ok).toBe(false);
		const second = await tool.execute("new", { title: "New", steps: [{ title: "New", command: "new" }] });
		f.save(second.details!);
		expect((await runRunbook(second.details!.runbookId, 1, "tui")).ok).toBe(true);
		await f.settle();
		expect(f.deliveries).toHaveLength(1);
		expect(f.deliveries[0]).toContain("new session");
	} finally {
		await f.close();
	}
});

test("assistant markdown cannot turn a runbook URI into an execution control", async () => {
	await initTheme(false);
	const f = fixture({ local: async () => ({ exitCode: 0, output: "must not run" }) });
	try {
		const result = await new RunbookTool(f.session).execute("markdown", {
			title: "Approval",
			steps: [{ title: "Run", command: "ignored" }],
		});
		f.save(result.details!);
		setExtensionLinks([RUNBOOK_LINK_SCHEME]);
		const id = result.details!.runbookId;
		for (const text of [
			`[Open docs](omp-runbook:${id}/all)`,
			`<omp-runbook:${id}/1>`,
			`[Run](OMP-RUNBOOK:${id}/all)`,
		]) {
			const rows = new Markdown(text, 0, 0, getMarkdownTheme()).render(120);
			const labels = rows.flatMap(row => extensionLinkLabels(row));
			for (const label of labels) await activateRunbookLink(label.url, f.journal.getSessionId());
			expect(labels).toEqual([]);
			expect(rows.join("")).not.toContain("\x1b]8;");
		}
		expect(f.jobs.getAllJobs()).toHaveLength(0);
		expect(runbookLines(result.details!).flatMap(row => extensionLinkLabels(row))).toHaveLength(2);
	} finally {
		await f.close();
		setExtensionLinks([]);
	}
});

test("hand-built OSC8 runbook markers in assistant markdown cannot start jobs", async () => {
	await initTheme(false);
	const f = fixture({ local: async () => ({ exitCode: 0, output: "must not run" }) });
	try {
		const result = await new RunbookTool(f.session).execute("forged-marker", {
			title: "Approval",
			steps: [{ title: "Run", command: "ignored" }],
		});
		f.save(result.details!);
		setExtensionLinks([RUNBOOK_LINK_SCHEME]);
		const id = result.details!.runbookId;
		for (const suffix of ["", "#00000000-0000-0000-0000-000000000000"]) {
			const url = `omp-runbook:${id}/all${suffix}`;
			const source = `\x1b]8;id=omp-extension-link;${url}\x07Run all\x1b]8;;\x07`;
			const rows = new Markdown(source, 0, 0, getMarkdownTheme()).render(120);
			const labels = rows.flatMap(row => extensionLinkLabels(row));
			expect(labels.map(label => label.url)).toContain(url);
			for (const label of labels)
				expect((await activateRunbookLink(label.url, f.journal.getSessionId())).ok).toBe(false);
		}
		expect(f.jobs.getAllJobs()).toHaveLength(0);
		expect(f.deliveries).toEqual([]);
	} finally {
		await f.close();
		setExtensionLinks([]);
	}
});
