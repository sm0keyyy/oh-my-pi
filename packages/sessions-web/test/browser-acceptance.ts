import type { ElementHandle, Page } from "puppeteer-core";
import * as path from "node:path";

type Frame = {
	id?: string;
	command?: string;
	success?: boolean;
	error?: string;
	data?: Record<string, unknown>;
	type: string;
};
declare global {
	interface Window {
		acceptance: { socket: WebSocket; request(command: Record<string, unknown>): Promise<Frame> };
	}
}

export async function runBrowserAcceptance(page: Page, base: string, root: string, viewport: "desktop" | "phone") {
	const width = viewport === "desktop" ? 1440 : 390;
	const height = viewport === "desktop" ? 1000 : 844;
	await page.setViewport({
		width,
		height,
		deviceScaleFactor: 1,
		isMobile: viewport === "phone",
		hasTouch: viewport === "phone",
	});
	const dir = path.join(root, "packages/sessions-web/evidence/screenshots");
	const results: Array<{ command: string; coverage: string; success: boolean; response: Frame; screenshot: string }> =
		[];
	const receipt = async () =>
		(await (await fetch(base + "/fixture/receipts")).json()) as Array<{ direction: string; frame: Frame }>;
	const reveal = async (element: ElementHandle) => {
		const summary = await element.evaluateHandle(node =>
			node.closest("details:not([open])")?.querySelector("summary"),
		);
		const button = summary.asElement() as ElementHandle<Element> | null;
		if (button && (await button.boundingBox())) await button.click();
		await summary.dispose();
	};
	const click = async (label: string, aria = false) => {
		const deadline = Date.now() + 10000;
		while (Date.now() < deadline) {
			for (const element of await page.$$("button, summary")) {
				if (
					await element.evaluate(
						(node, label, aria) => (aria ? node.getAttribute("aria-label") : node.textContent?.trim()) === label,
						label,
						aria,
					)
				)
					await reveal(element);
				const match = await element.evaluate(
					(node, label, aria) => {
						const open = [...document.querySelectorAll("dialog[open]")].at(-1);
						return (
							(aria ? node.getAttribute("aria-label") : node.textContent?.trim()) === label &&
							(!open || node.closest("dialog") === open) &&
							!!node.getBoundingClientRect().width &&
							!node.matches(":disabled")
						);
					},
					label,
					aria,
				);
				if (match) {
					if (
						await element.evaluate(
							node => node.tagName === "SUMMARY" && (node.parentElement as HTMLDetailsElement).open,
						)
					)
						return;
					await element.click();
					return;
				}
			}
			await Bun.sleep(100);
		}
		throw new Error(`Button unavailable: ${label}`);
	};
	const field = async (label: string, value: string, select = false) => {
		for (const node of await page.$$("label")) {
			if (await node.evaluate((node, label) => node.textContent?.trim().startsWith(label), label)) {
				await reveal(node);
				const input = await node.$(select ? "select" : "input, textarea");
				if (!input || !(await input.boundingBox())) continue;
				if (select) await input.select(value);
				else {
					await input.click({ count: 3 });
					await input.press("Backspace");
					await input.type(value);
				}
				return;
			}
		}
		throw new Error(`Field unavailable: ${label}`);
	};
	const close = async () => {
		for (let i = 0; i < 5; i++) {
			const dialog = (await page.$$("dialog[open]")).at(-1);
			const button = await dialog?.$(":scope > .dlg-head button");
			if (!button) break;
			await button.click();
		}
	};
	const panels = async () => {
		if (viewport === "phone" && !(await page.$("dialog[open]"))) await click("Panels", true);
	};
	const shot = async (name: string) => {
		const filename = path.join(dir, `${name}-${viewport}.png`);
		await page.screenshot({ path: filename });
		return path.relative(root, filename);
	};
	const record = async (command: string, action: () => Promise<unknown>, coverage = "browser", expected = true) => {
		const before = (await receipt()).length;
		await action();
		let response: Frame | undefined;
		const deadline = Date.now() + 120000;
		while (Date.now() < deadline) {
			const rows = (await receipt()).slice(before);
			response = rows.find(row => row.direction === "response" && row.frame.command === command)?.frame;
			if (response) break;
			await Bun.sleep(100);
		}
		if (!response) throw new Error(`No RPC response: ${command}`);
		await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'), { timeout: 10000 });
		const screenshot = await shot(command);
		results.push({ command, coverage, success: response.success === expected, response, screenshot });
		await Bun.write(
			path.join(root, `packages/sessions-web/evidence/${viewport}-partial.json`),
			JSON.stringify(results),
		);
		if (response.success !== expected) throw new Error(`${command}: ${JSON.stringify(response)}`);
		return response;
	};
	const compose = async (value: string) => {
		await close();
		await page.focus("#message");
		await page.click("#message", { count: 3 });
		await page.keyboard.press("Backspace");
		await page.type("#message", value);
		await click("Send");
	};
	const idle = async () => {
		await page.waitForFunction(() => !document.querySelector(".seg"), { timeout: 120000 });
	};
	const installProbe = async () => {
		await page.evaluate(async () => {
			const socket = new WebSocket(
				`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws/session/${location.pathname.split("/").at(-1)}`,
			);
			const pending = new Map<string, { resolve(value: Frame): void; reject(error: Error): void; timer: number }>();
			const ready = Promise.withResolvers<void>();
			socket.onmessage = event => {
				const frame = JSON.parse(event.data) as Frame;
				if (frame.type === "ready") ready.resolve();
				if (frame.id && pending.has(frame.id)) {
					const item = pending.get(frame.id)!;
					clearTimeout(item.timer);
					pending.delete(frame.id);
					item.resolve(frame);
				}
			};
			socket.onclose = () => {
				ready.reject(new Error("Probe closed"));
				for (const item of pending.values()) {
					clearTimeout(item.timer);
					item.reject(new Error("Probe closed"));
				}
				pending.clear();
			};
			window.acceptance = {
				socket,
				request(command) {
					const id = crypto.randomUUID();
					const result = Promise.withResolvers<Frame>();
					const timer = window.setTimeout(() => {
						pending.delete(id);
						result.reject(new Error("Probe timeout"));
					}, 120000);
					pending.set(id, { ...result, timer });
					socket.send(JSON.stringify({ ...command, id }));
					return result.promise;
				},
			};
			await ready.promise;
		});
	};
	const rpc = (command: Record<string, unknown>) =>
		page.evaluate(command => window.acceptance.request(command), command);
	await page.goto(base);
	const lobbyStart = Date.now();
	const started = await (await fetch(`${base}/fixture/start?name=${viewport}`)).json();
	if (!started.pid) throw new Error(JSON.stringify(started));
	await page.waitForFunction(
		viewport => Array.from(document.querySelectorAll(".row-name a")).some(node => node.textContent === viewport),
		{ timeout: 30000 },
		viewport,
	);
	const appearMs = Date.now() - lobbyStart;
	await shot("lobby-open");
	const sessions = await (await fetch(base + "/api/sessions")).json();
	const target = sessions.sessions.find((session: { cwd: string }) => session.cwd.endsWith("/" + viewport));
	if (!target) throw new Error("Isolated session not discovered");
	const beforeBoot = (await receipt()).length;
	await page.goto(`${base}/session/${target.instanceId}`);
	await page.waitForFunction(
		() => {
			const message = document.querySelector<HTMLTextAreaElement>("#message");
			return message && !message.disabled && !!document.querySelector(".rail");
		},
		{ timeout: 20000 },
	);
	const initialScreenshot = await shot("session-initial");
	await installProbe();
	await rpc({ type: "set_fast_mode", enabled: false });
	await rpc({ type: "set_auto_compaction", enabled: true });
	await page.waitForFunction(
		() => Array.from(document.querySelectorAll("button")).some(button => button.textContent === "Auto compact on"),
		{ timeout: 10000 },
	);
	for (const command of [
		"negotiate_protocol",
		"set_event_filter",
		"set_ask_dialog",
		"set_subagent_subscription",
		"get_state",
		"get_messages",
		"get_available_commands",
		"get_available_models",
		"get_available_thinking_levels",
		"get_subagents",
		"get_session_stats",
	]) {
		const response = (await receipt())
			.slice(beforeBoot)
			.find(row => row.direction === "response" && row.frame.command === command)?.frame;
		if (!response?.success) throw new Error(`Automatic boot RPC missing: ${command}`);
		results.push({ command, coverage: "automatic", success: true, response, screenshot: initialScreenshot });
	}
	const attachment = await page.$('input[type="file"]');
	if (!attachment) throw new Error("Image attachment input missing");
	await attachment.uploadFile(path.join(root, ".sessions-d-test-config/sample.png"));
	await page.waitForSelector(".attach");
	await record("prompt", () => compose(`Hello ${viewport}. **Local markdown**.`));
	await idle();
	await compose("[tool] Read the local fixture");
	await idle();
	await page.waitForSelector(".tv-card", { timeout: 10000 });
	await shot("tool-view");
	await panels();
	await record("set_fast_mode", () => click("Fast off"));
	await record("set_auto_compaction", () => click("Auto compact on"));
	await record("cycle_model", () => click("Cycle model"));
	await record("cycle_thinking_level", () => click("Cycle thinking"));
	await record("set_steering_mode", () => field("Steering mode", "all", true));
	await record("set_follow_up_mode", () => field("Follow-up mode", "all", true));
	await record("set_interrupt_mode", () => field("Interrupt mode", "wait", true));
	await record("set_cache_warming", () => field("Cache warming", "off", true));
	await record("set_auto_retry", () => click("Enable retry"));
	await record("abort_retry", () => click("Stop retry"));
	await close();
	await panels();
	await click(viewport === "desktop" ? "gpt-4.1-2 ▾" : "gpt-4.1-2 ▾");
	await record("set_model", () => click("fake/gpt-4.1"));
	await close();
	await panels();
	await click((await rpc({ type: "get_state" })).data?.thinkingLevel + " ▾");
	await record("set_thinking_level", () => click("low"));
	await close();
	await record("bash", () => compose("!printf browser-bash"));
	await idle();
	const bash = compose("!sleep 30");
	await page.waitForFunction(
		() => Array.from(document.querySelectorAll("button")).some(button => button.textContent === "Stop"),
		{ timeout: 10000 },
	);
	await record("abort_bash", () => click("Stop"));
	await bash;
	await panels();
	await click("Edit todos");
	await field("Add task", `Local ${viewport} task`);
	await click("Add task");
	await record("set_todos", () => click("Save todos"));
	await close();
	await panels();
	await click("Session");
	await field("Session name", `Browser ${viewport}`);
	await record("set_session_name", () => click("Rename"));
	await click("Context and export");
	await record("get_last_assistant_text", () => click("Last assistant text"));
	await close();
	await panels();
	await record("get_messages_page", () => click("Messages page"));
	await close();
	await panels();
	await record("export_html", () => click("Export HTML"));
	await close();
	await panels();
	await record("compact", () => click("Compact"));
	await close();
	await compose("[slow] queue acceptance");
	await page.waitForSelector(".seg");
	await record("follow_up", async () => {
		await click("Queue");
		await compose("Queued local followup");
	});
	await record("promote_queued_message", () => click("Promote Queued local followup", true));
	await record("remove_queued_message", () => click("Remove Queued local followup", true));
	await record("steer", async () => {
		await click("Steer");
		await compose("Local steer");
	});
	await record("abort", () => click("Stop"));
	await idle();
	await compose("[agent] Spawn local agent");
	let subagentId = "";
	const agentDeadline = Date.now() + 30000;
	while (Date.now() < agentDeadline) {
		const response = await rpc({ type: "get_subagents" });
		const agents = response.data?.subagents as Array<{ id: string; status: string }>;
		subagentId = agents.find(agent => agent.status === "running")?.id ?? "";
		if (subagentId) break;
		await Bun.sleep(200);
	}
	if (!subagentId) throw new Error("Real task did not spawn a subagent");
	await panels();
	await record("get_subagent_messages", () => click("Messages"));
	await field("Steer agent", "Local subagent steer");
	await record("steer_subagent", () => click("Send steer"));
	await close();
	await panels();
	await record("cancel_subagent", () => click("Cancel"));
	await close();
	await idle();
	for (const method of ["select", "confirm", "input", "editor", "ask"]) {
		await compose(`/web-dialog ${method}`);
		await page.waitForSelector(".dlg");
		await shot(`dialog-${method}`);
		if (method === "input" || method === "editor") {
			const selector = method === "editor" ? '.dlg textarea[name="value"]' : '.dlg input[name="value"]';
			await page.click(selector, { count: 3 });
			await page.keyboard.press("Backspace");
			await page.type(selector, `Local ${viewport} answer`);
		}
		if (method === "ask") {
			await page.click('.dlg input[value="Desktop"]');
			await page.click('.dlg input[value="Phone"]');
		}
		await click(
			method === "select" ? "Choose" : method === "confirm" ? "Yes" : method === "ask" ? "Answer" : "Submit",
		);
		await page.waitForFunction(() => !document.querySelector(".dlg"));
	}
	await compose("/web-dialog status");
	await panels();
	await shot("widgets-status");
	await close();
	await page.focus("#message");
	await record("predict_word", () => page.type("#message", "hel"));
	if (await page.$(".ghost")) await record("predict_word_feedback", () => page.keyboard.press("Tab"));
	else
		await record(
			"predict_word_feedback",
			() => rpc({ type: "predict_word_feedback", text: "hel", cursor: 3, suggestion: "lo", accepted: true }),
			"transport: predictor returned no suggestion",
		);
	await page.click("#message", { count: 3 });
	await page.keyboard.press("Backspace");
	await page.type("#message", "/settings");
	await page.waitForSelector('[aria-disabled="true"]');
	await shot("terminal-only-palette");
	await page.keyboard.press("Escape");
	await page.keyboard.press("Backspace");
	for (const command of [
		{ type: "get_login_providers" },
		{ type: "login", providerId: "local-invalid-provider" },
		{ type: "live_start", instructions: "{{" },
		{ type: "live_stop" },
		{ type: "live_mute", muted: true },
		{ type: "abort_and_prompt", message: "Local transport-only abort and prompt" },
	]) {
		const before = (await receipt()).length;
		const response = await rpc(command);
		results.push({
			command: command.type,
			coverage:
				command.type === "live_start"
					? "negative transport: invalid instructions; not voice functionality"
					: "transport: G2 excludes this control",
			success: typeof response.success === "boolean",
			response,
			screenshot: await shot(command.type),
		});
		if ((await receipt()).length <= before) throw new Error("No transport receipt");
	}
	await idle();
	await panels();
	await click("Session");
	await record("get_entries", () => click("Session entries"));
	await close();
	await panels();
	await record("get_tree", () => click("Tree snapshot"));
	await close();
	await panels();
	await record("get_branch_messages", () => click("Branch messages"));
	await shot("branch-picker");
	await record("branch", () => click("Branch here"));
	await close();
	await panels();
	await record("fork", () => click("Fork current session"));
	await close();
	const state = (await rpc({ type: "get_state" })).data!;
	const sessionPath = String(state.sessionFile);
	await panels();
	await record("new_session", () => click("New session in this TUI"));
	await close();
	await panels();
	await field("Session path on the Mac", sessionPath);
	await record("switch_session", () => click("Switch session"));
	await close();
	await panels();
	await field("Directory on the Mac", started.cwd ?? target.cwd);
	await record("open_session", () => click("Open directory"));
	await close();
	await compose("Local handoff setup");
	await idle();
	await panels();
	await click("Context and export");
	await record("handoff", () => click("Handoff"));
	await close();
	await panels();
	await click("Goal");
	await field("Objective", "Local acceptance objective");
	await record("goal", () => click("Create goal"));
	await close();
	const dropGoal = rpc({ type: "goal", op: "drop" });
	await page.waitForSelector(".dlg");
	await click("Yes");
	await dropGoal;
	await compose("[slow] reconnect acceptance");
	await page.waitForSelector(".seg");
	await page.waitForFunction(
		() => document.querySelector('[aria-label="Transcript"]')?.textContent?.includes("stream-2"),
		{ timeout: 20000 },
	);
	await shot("reconnect-before");
	await fetch(base + "/fixture/drop?ms=5000");
	await page.waitForFunction(() => document.body.innerText.includes("Reconnecting"), { timeout: 10000 });
	await shot("reconnect-offline");
	await page.waitForFunction(
		() => !document.body.innerText.includes("Reconnecting") && !document.body.innerText.includes("Rebuilding"),
		{ timeout: 30000 },
	);
	await page.waitForFunction(
		() => document.querySelector('[aria-label="Transcript"]')?.textContent?.includes("stream-12"),
		{ timeout: 30000 },
	);
	await shot("reconnect-restored");
	await installProbe();
	await click("Stop");
	await idle();
	await Bun.sleep(1000);
	const final = (await rpc({ type: "get_messages" })).data?.messages as Array<{
		role: string;
		timestamp?: number;
		toolCallId?: string;
		content?: unknown;
	}>;
	const keys = final
		.filter(message => message.role !== "toolResult")
		.map(message => `${message.role}:${message.timestamp}:${message.toolCallId ?? ""}`);
	const actual = await page.$$eval('[aria-label="Transcript"] article[data-message-key]', nodes =>
		nodes.map(node => node.getAttribute("data-message-key")),
	);
	if (JSON.stringify(keys) !== JSON.stringify(actual))
		throw new Error(`Reconnect transcript differs: ${JSON.stringify({ keys, actual })}`);
	await shot("reconnect-matches-tui");
	const streamingText = final
		.flatMap(message => (Array.isArray(message.content) ? message.content : []))
		.filter(part => part.type === "text" && part.text.includes("stream-"))
		.at(-1)?.text;
	const transcriptText = await page.$eval('[aria-label="Transcript"]', node => node.textContent ?? "");
	if (!streamingText || !transcriptText.includes(streamingText)) throw new Error("Reconnect lost streaming text");
	const finalState = (await rpc({ type: "get_state" })).data;
	if (finalState?.isStreaming !== false || (await page.$(".seg")))
		throw new Error("Reconnect streaming state differs from the TUI");
	await page.goto(base);
	const closedAt = Date.now();
	await fetch(`${base}/fixture/stop?name=${viewport}`);
	await page.waitForFunction(
		id => !document.querySelector(`[data-instance-id="${id}"]`),
		{ timeout: 30000 },
		target.instanceId,
	);
	const disappearMs = Date.now() - closedAt;
	await shot("lobby-closed");
	return {
		viewport: [width, height],
		instanceId: target.instanceId,
		lobby: { appearMs, disappearMs },
		checklist: results,
		reconnect: { matches: true, messageCount: final.length, keys },
		screenshots: results.map(result => result.screenshot),
	};
}

export async function runLobbyQuestionAcceptance(page: Page, base: string, root: string) {
	const names = ["lobby-desktop", "lobby-phone"];
	const expected = "Which local option?\nChoose local checks";
	const screenshots: string[] = [];
	const lobby = await page.browser().newPage();
	try {
		for (const name of names) {
			const response = await fetch(`${base}/fixture/start?name=${name}`);
			if (!response.ok) throw new Error(`Fixture start failed: ${await response.text()}`);
		}
		let target: { instanceId: string; cwd: string } | undefined;
		for (let attempt = 0; attempt < 60; attempt++) {
			const body = await (await fetch(`${base}/api/sessions`)).json();
			target = body.sessions.find((session: { cwd: string }) => session.cwd.endsWith("/lobby-desktop"));
			if (target && body.sessions.length === 2) break;
			await Bun.sleep(200);
		}
		if (!target) throw new Error("Waiting source TUI was not discovered");
		await page.bringToFront();
		await page.goto(`${base}/session/${target.instanceId}`);
		await page.waitForFunction(() => {
			const input = document.querySelector<HTMLTextAreaElement>("#message");
			return input && !input.disabled;
		});
		await page.type("#message", "/web-dialog ask");
		await page.keyboard.press("Enter");
		await page.waitForSelector(".dlg");
		const capture = async (name: string) => {
			const screenshot = `packages/sessions-web/evidence/screenshots/${name}.png`;
			await lobby.screenshot({ path: path.join(root, screenshot) });
			screenshots.push(screenshot);
		};
		const results = [];
		for (const viewport of ["desktop", "phone"]) {
			const width = viewport === "desktop" ? 1440 : 390;
			const height = viewport === "desktop" ? 1000 : 844;
			await lobby.setViewport({
				width,
				height,
				isMobile: viewport === "phone",
				hasTouch: viewport === "phone",
			});
			await lobby.bringToFront();
			await lobby.goto(base);
			await lobby.waitForFunction(
				(id, expected) => document.querySelector(`[data-instance-id="${id}"] .row-ask`)?.textContent === expected,
				{ timeout: 30000 },
				target.instanceId,
				expected,
			);
			const order = await lobby.$$eval("[data-instance-id]", nodes =>
				nodes.map(node => node.getAttribute("data-instance-id")),
			);
			if (order[0] !== target.instanceId) throw new Error("Waiting session is not first");
			const actualViewport = await lobby.evaluate(() => [innerWidth, innerHeight]);
			if (actualViewport[0] !== width || actualViewport[1] !== height) throw new Error("Viewport mismatch");
			const body = await (await fetch(`${base}/api/sessions`)).json();
			const snapshot = body.sessions.find(
				(session: { instanceId: string }) => session.instanceId === target.instanceId,
			);
			if (!snapshot?.inputRequired || snapshot.questionText !== expected)
				throw new Error("Gateway snapshot differs from the real question");
			await capture(`lobby-question-${viewport}`);
			results.push({ viewport: [width, height], instanceId: target.instanceId, questionText: expected, order });
		}
		await page.bringToFront();
		await page.click('.dlg input[value="Desktop"]');
		await page.click('.dlg button[type="submit"]');
		await page.waitForFunction(() => !document.querySelector(".dlg"));
		await lobby.bringToFront();
		await lobby.waitForFunction(
			id =>
				!document.querySelector(`[data-instance-id="${id}"] .row-ask`) &&
				!!document.querySelector(`.group:not(.group-waiting) [data-instance-id="${id}"]`),
			{ timeout: 30000 },
			target.instanceId,
		);
		const body = await (await fetch(`${base}/api/sessions`)).json();
		const cleared = body.sessions.find((session: { instanceId: string }) => session.instanceId === target.instanceId);
		if (!cleared || cleared.inputRequired || cleared.questionText !== undefined)
			throw new Error("Answered question remained in the gateway snapshot");
		await capture("lobby-question-cleared-phone");
		await lobby.setViewport({ width: 1440, height: 1000, isMobile: false, hasTouch: false });
		await capture("lobby-question-cleared-desktop");
		return { results, cleared: true, screenshots };
	} finally {
		await lobby.close();
		for (const name of names) await fetch(`${base}/fixture/stop?name=${name}`);
	}
}
