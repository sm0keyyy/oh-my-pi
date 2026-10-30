import * as assert from "node:assert/strict";
import * as path from "node:path";
import { isRecord } from "@oh-my-pi/web-render";
import puppeteer, { type Page } from "puppeteer-core";
import type { RecordValue } from "../src/client";
import { installHttpProbe } from "./http-probe";

export async function runReviewFixAcceptance(page: Page, base: string, root: string, viewport: "desktop" | "phone") {
	const width = viewport === "desktop" ? 1440 : 390;
	const height = viewport === "desktop" ? 1000 : 844;
	await page.setViewport({ width, height, isMobile: viewport === "phone", hasTouch: viewport === "phone" });
	await page.bringToFront();
	const started = await (await fetch(`${base}/fixture/start?name=${viewport}`)).json();
	assert.ok(started.pid, JSON.stringify(started));
	const screenshots: string[] = [];
	const commands: Array<{
		command: string;
		coverage: "transport";
		request: RecordValue;
		response: RecordValue;
		screenshot: string;
	}> = [];
	const receipts = async (): Promise<Array<{ direction?: string; frame?: RecordValue }>> =>
		(await fetch(`${base}/fixture/receipts`)).json();
	const shot = async (label: string) => {
		const screenshot = `packages/sessions-web/evidence/screenshots/review-fixes-${label}-${viewport}.png`;
		await page.screenshot({ path: path.join(root, screenshot) });
		screenshots.push(screenshot);
		return screenshot;
	};
	const compose = async (message: string) => {
		await page.waitForSelector("#message:not(:disabled)");
		await page.click("#message", { count: 3 });
		await page.keyboard.press("Backspace");
		await page.type("#message", message);
		await page.keyboard.press("Enter");
	};
	const panels = async (open: boolean) => {
		if (viewport !== "phone") return;
		if (open) await page.click('button[aria-label="Panels"]');
		else await page.click('button[aria-label="Close Panels"]');
	};
	const installProbe = async () => {
		await page.evaluate(installHttpProbe, "reviewAcceptance");
	};
	const rpc = (command: RecordValue): Promise<RecordValue> =>
		page.evaluate(command => window.httpProbes.reviewAcceptance!.request(command), command);
	const record = async (command: RecordValue) => {
		const response = await rpc(command);
		assert.equal(response.success, true, JSON.stringify(response));
		const rows = await receipts();
		const request = rows.find(row => row.direction === "command" && row.frame?.id === response.id)?.frame;
		const received = rows.find(row => row.direction === "response" && row.frame?.id === response.id)?.frame;
		assert.ok(request && received, "The real TUI round trip needs both wire receipts");
		assert.deepEqual(received, response);
		commands.push({
			command: String(command.type),
			coverage: "transport",
			request,
			response,
			screenshot: await shot(String(command.type)),
		});
		return isRecord(response.data) ? response.data : {};
	};
	try {
		await page.goto(base);
		assert.deepEqual(await page.evaluate(() => [innerWidth, innerHeight]), [width, height]);
		await page.waitForSelector(`[data-instance-id] .row-name a`);
		const href = await page.$eval(".row-name a", node => node.getAttribute("href"));
		assert.ok(href);
		await page.goto(base + href);
		await page.waitForSelector("#message:not(:disabled)");
		await installProbe();

		await compose("/web-dialog ask");
		await page.waitForSelector('.dlg input[name="choice"]');
		await page.click('.dlg input[name="choice"][value=""]');
		await page.type('.dlg input[name="choice-custom"]', "   ");
		const beforeInvalid = (await receipts()).length;
		await page.click('.dlg button[type="submit"]');
		await page.waitForSelector(".dlg [role=alert]");
		assert.equal(
			await page.$eval('.dlg input[name="choice-custom"]', node => (node as HTMLInputElement).value),
			"   ",
		);
		assert.equal(
			(await receipts())
				.slice(beforeInvalid)
				.some(row => row.direction === "command" && row.frame?.type === "extension_ui_response"),
			false,
		);
		await shot("F8-invalid-kept");
		await page.click('.dlg input[name="choice-custom"]', { count: 3 });
		await page.keyboard.press("Backspace");
		await page.type('.dlg input[name="choice-custom"]', `Alternative ${viewport}`);
		await page.click('.dlg input[value="Desktop"]');
		await page.click('.dlg button[type="submit"]');
		await page.waitForFunction(() => !document.querySelector(".dlg"));
		await page.waitForFunction(() => document.body.textContent?.includes("Local dialog result:"));
		const submitted = (await receipts())
			.filter(row => row.direction === "command" && row.frame?.type === "extension_ui_response")
			.at(-1)?.frame;
		assert.ok(submitted && Array.isArray(submitted.answers));
		assert.deepEqual(submitted.answers[0], {
			id: "choice",
			selectedOptions: [],
			customInput: `Alternative ${viewport}`,
		});
		await shot("F8-custom-accepted");

		const beforeOutput = (await receipts()).length;
		await compose("/session info");
		await page.waitForSelector(".command-results[open] pre");
		const output = (await receipts()).slice(beforeOutput).find(row => row.frame?.type === "command_output")?.frame;
		assert.ok(output && typeof output.text === "string");
		assert.equal(await page.$eval(".command-results pre", node => node.textContent), output.text);
		assert.equal(
			await page.$eval('[aria-label="Transcript"]', (node, text) => node.textContent?.includes(text), output.text),
			false,
		);
		await page.browserContext().overridePermissions(base, ["clipboard-read", "clipboard-sanitized-write"]);
		await page.click(".command-results .actions button:first-child");
		await page.waitForFunction(async text => (await navigator.clipboard.readText()) === text, {}, output.text);
		assert.equal(await page.evaluate(() => navigator.clipboard.readText()), output.text);
		await shot("F11-command-results");
		await page.click(".command-results summary");
		await compose("/session info");
		await page.waitForFunction(
			() =>
				!!document.querySelector(".command-results[open]") &&
				document.querySelector(".command-results pre")?.textContent?.includes("\n\n"),
		);
		await page.click(".command-results .actions button:last-child");
		await page.waitForFunction(() => !document.querySelector(".command-results"));

		await compose("/web-dialog status");
		await page.waitForFunction(() => document.querySelector(".rail")?.textContent?.includes("Local status"));
		await page.reload();
		await page.waitForSelector("#message:not(:disabled)");
		await panels(true);
		await page.waitForFunction(
			() =>
				document.querySelector(".rail")?.textContent?.includes("Local widget") &&
				document.querySelector(".rail")?.textContent?.includes("Local status"),
		);
		const hostSnapshot = (await receipts())
			.filter(
				row =>
					row.frame?.method === "snapshot" &&
					isRecord(row.frame.statuses) &&
					row.frame.statuses.fixture === "Local status",
			)
			.at(-1)?.frame;
		assert.ok(hostSnapshot, "Reconnect must receive the authoritative host UI snapshot");
		await shot("F12-snapshot-restored");
		await panels(false);
		await compose("/web-dialog clear");
		await panels(true);
		await page.waitForFunction(
			() =>
				!document.querySelector(".rail")?.textContent?.includes("Local widget") &&
				!document.querySelector(".rail")?.textContent?.includes("Local status"),
		);
		await shot("F12-explicit-clears");
		await panels(false);

		await compose("[slow] Reconnect regression");
		await page.waitForFunction(() =>
			document.querySelector('[aria-label="Transcript"]')?.textContent?.includes("stream-2"),
		);
		await fetch(`${base}/fixture/drop?ms=1000`);
		await page.waitForFunction(() => document.body.innerText.includes("Reconnecting"));
		await page.waitForSelector("#message:not(:disabled)", { timeout: 30000 });
		await page.waitForFunction(
			() => document.querySelector('[aria-label="Transcript"]')?.textContent?.includes("stream-5"),
			{ timeout: 30000 },
		);
		await shot("F6-stream-restored");
		await installProbe();
		await rpc({ type: "follow_up", message: `Restore this ${viewport} queue` });
		const restored = await record({ type: "abort_and_restore_queue" });
		assert.ok(JSON.stringify(restored).includes(`Restore this ${viewport} queue`));
		await page.waitForFunction(() => !document.querySelector(".seg"));
		await record({ type: "set_slow_mode", enabled: false });
		const accounts = await record({ type: "get_logout_accounts", providerId: "fake" });
		assert.ok(Array.isArray(accounts.accounts));
		const account = accounts.accounts.find(isRecord);
		assert.ok(account && typeof account.credentialId === "number");
		await record({ type: "logout", providerId: "fake", credentialId: account.credentialId });
		const remaining = await rpc({ type: "get_logout_accounts", providerId: "fake" });
		assert.ok(isRecord(remaining.data));
		assert.deepEqual(remaining.data.accounts, []);
		const btw = await record({ type: "btw", question: `[slow] Side question ${viewport}` });
		assert.ok(isRecord(btw.record) && typeof btw.record.id === "string");
		const recordId = btw.record.id;
		const cancelled = await record({ type: "btw_cancel", recordId });
		assert.equal(cancelled.cancelled, true);
		const history = await record({ type: "get_btw_history" });
		assert.ok(
			Array.isArray(history.records) && history.records.some(record => isRecord(record) && record.id === recordId),
		);
		return {
			viewport: [width, height],
			tui: { pid: started.pid, cwd: started.cwd },
			findings: {
				F8: { invalidKept: true, submitted },
				F11: { visible: true, separate: true, copy: true, reopen: true, clear: true, output },
				F12: { restored: true, explicitClears: true, hostSnapshot },
				F6: { streamingRebuilt: true },
			},
			commands,
			screenshots,
		};
	} finally {
		await page.evaluate(() => window.httpProbes?.reviewAcceptance?.source.close());
		await fetch(`${base}/fixture/stop?name=${viewport}`);
	}
}

if (import.meta.main) {
	const base = process.argv[2];
	const executablePath = process.env.CHROME_BIN;
	assert.ok(base && executablePath, "Usage: CHROME_BIN=/path/to/chrome bun test/review-acceptance.ts <fixture-url>");
	const browser = await puppeteer.launch({ executablePath, headless: true });
	const root = path.resolve(import.meta.dir, "../../..");
	const results = [];
	try {
		const page = await browser.newPage();
		for (const viewport of ["desktop", "phone"] as const) {
			results.push(await runReviewFixAcceptance(page, base, root, viewport));
			await Bun.write(
				path.join(root, "packages/sessions-web/evidence/review-fixes-browser.json"),
				`${JSON.stringify(results, null, 2)}\n`,
			);
		}
		console.log(JSON.stringify(results));
	} finally {
		await browser.close();
	}
}
