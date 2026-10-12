import * as assert from "node:assert/strict";
import * as path from "node:path";
import puppeteer, { type Page } from "puppeteer-core";

export async function runMobileWidthAcceptance(page: Page, base: string, root: string) {
	const started = await (await fetch(`${base}/fixture/start?name=phone`)).json();
	assert.ok(started.pid, JSON.stringify(started));
	await page.goto(base);
	await page.waitForSelector(".row-name a", { timeout: 30000 });
	await page.click(".row-name a");
	await page.waitForSelector("#message:not(:disabled)");
	await page.type("#message", "[tool] Mobile width acceptance");
	await page.click("button.btn-primary");
	await page.waitForSelector(".tr-md table", { timeout: 60000 });
	await page.waitForFunction(() => !document.querySelector(".seg"), { timeout: 60000 });
	assert.equal(await page.$(".entry [role=alert]"), null, "Fixture transcript must complete without errors");
	const measurements = [];
	const screenshots: string[] = [];
	for (const [name, width, height] of [
		["phone", 390, 844],
		["desktop", 1440, 1000],
	] as const) {
		await page.setViewport({
			width,
			height,
			deviceScaleFactor: 1,
			isMobile: name === "phone",
			hasTouch: name === "phone",
		});
		await page.waitForSelector(".tr-md table", { timeout: 30000 });
		for (const button of await page.$$('.tv-head[aria-expanded="false"]')) {
			await button.evaluate(node => node.scrollIntoView({ block: "center" }));
			await button.click();
		}
		await page.waitForSelector(".tv-diff");
		const measurement = await page.evaluate(() => {
			const documentWidth = document.documentElement;
			const transcript = document.querySelector<HTMLElement>(".scroll")!;
			const blocks = [...document.querySelectorAll<HTMLElement>(".tr-md pre, .tr-md table, .tv-pre, .tv-diff")]
				.filter(
					node =>
						node.matches(".tr-md pre, .tr-md table, .tv-diff") ||
						node.closest(".tv-card")?.querySelector(".tv-name")?.textContent === "read" ||
						node.scrollWidth > node.clientWidth,
				)
				.map(node => {
					node.scrollLeft = 32;
					const result = {
						kind: node.matches(".tv-diff")
							? "diff"
							: node.matches(".tv-pre")
								? "tool"
								: node.tagName.toLowerCase(),
						clientWidth: node.clientWidth,
						scrollWidth: node.scrollWidth,
						scrollLeft: node.scrollLeft,
						overflowX: getComputedStyle(node).overflowX,
						whiteSpace: getComputedStyle(node.querySelector(".tv-diff-row") ?? node).whiteSpace,
					};
					node.scrollLeft = 0;
					return result;
				});
			const prose = [...document.querySelectorAll<HTMLElement>(".tr-md p, .tr-md h1, .tr-md li")].map(node => ({
				tag: node.tagName,
				clientWidth: node.clientWidth,
				scrollWidth: node.scrollWidth,
			}));
			return {
				viewport: { width: innerWidth, height: innerHeight },
				clientWidth: documentWidth.clientWidth,
				scrollWidth: documentWidth.scrollWidth,
				transcript: { clientWidth: transcript.clientWidth, scrollWidth: transcript.scrollWidth },
				blocks,
				prose,
			};
		});
		assert.equal(measurement.viewport.width, width);
		assert.equal(measurement.viewport.height, height);
		assert.equal(measurement.scrollWidth, measurement.clientWidth, "The page must not scroll sideways");
		assert.equal(
			measurement.transcript.scrollWidth,
			measurement.transcript.clientWidth,
			"The transcript must not scroll sideways",
		);
		for (const kind of ["pre", "table", "tool", "diff"])
			assert.ok(
				measurement.blocks.some(block => block.kind === kind),
				`Missing wide ${kind} block`,
			);
		for (const block of measurement.blocks) {
			assert.equal(block.overflowX, "auto");
			assert.ok(block.scrollLeft > 0, `${block.kind} must scroll inside itself`);
			assert.ok(["pre", "nowrap"].includes(block.whiteSpace), `${block.kind} must preserve alignment`);
		}
		for (const prose of measurement.prose)
			assert.equal(prose.scrollWidth, prose.clientWidth, `${prose.tag} must wrap`);
		for (const [label, selector] of [
			["prose", ".entry-assistant .tr-md"],
			["code-table", ".tr-md pre"],
			["tool", ".tv-pre"],
			["diff", ".tv-diff"],
		]) {
			await page.$eval(selector, node => node.scrollIntoView({ block: "start" }));
			const screenshot = `packages/sessions-web/evidence/screenshots/mobile-width-${name}-${label}.png`;
			await page.screenshot({ path: path.join(root, screenshot) });
			screenshots.push(screenshot);
		}
		if (name === "phone") {
			await page.click('button[aria-label="Panels"]');
			await page.waitForSelector(".panel-dialog[open]");
			const panel = await page.evaluate(() => ({
				clientWidth: document.documentElement.clientWidth,
				scrollWidth: document.documentElement.scrollWidth,
				width: document.querySelector(".panel-dialog[open]")!.getBoundingClientRect().width,
			}));
			assert.equal(panel.scrollWidth, panel.clientWidth);
			assert.ok(panel.width <= width);
			const screenshot = "packages/sessions-web/evidence/screenshots/mobile-width-phone-panel.png";
			await page.screenshot({ path: path.join(root, screenshot) });
			screenshots.push(screenshot);
			await page.click('.panel-dialog[open] button[aria-label="Close Panels"]');
			measurements.push({ ...measurement, panel });
		} else {
			await page.click('button[aria-label="Side panel"]');
			const collapsed = await page.evaluate(() => ({
				clientWidth: document.documentElement.clientWidth,
				scrollWidth: document.documentElement.scrollWidth,
				transcriptClientWidth: document.querySelector(".scroll")!.clientWidth,
				transcriptScrollWidth: document.querySelector(".scroll")!.scrollWidth,
			}));
			assert.equal(collapsed.scrollWidth, collapsed.clientWidth);
			assert.equal(collapsed.transcriptScrollWidth, collapsed.transcriptClientWidth);
			measurements.push({ ...measurement, collapsed });
		}
	}
	return { measurements, screenshots };
}

if (import.meta.main) {
	const base = process.argv[2];
	const executablePath = process.env.CHROME_BIN;
	assert.ok(base && executablePath, "Usage: CHROME_BIN=/path/to/chrome bun test/mobile-width.ts <width-fixture-url>");
	const browser = await puppeteer.launch({ executablePath, headless: true });
	try {
		const result = await runMobileWidthAcceptance(
			await browser.newPage(),
			base,
			path.resolve(import.meta.dir, "../../.."),
		);
		console.log(JSON.stringify(result));
	} finally {
		await browser.close();
	}
}
