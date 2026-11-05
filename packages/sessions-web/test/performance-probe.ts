import * as assert from "node:assert/strict";
import * as path from "node:path";
import puppeteer, { type Page } from "puppeteer-core";
import { isRecord } from "@oh-my-pi/pi-utils/type-guards";
import { readLines } from "@oh-my-pi/pi-utils/stream";

const root = path.resolve(import.meta.dir, "../../..");
const duration = Number(process.env.SESSIONS_SOAK_SECONDS ?? 3660);
const output = process.env.SESSIONS_PERF_OUTPUT ?? path.join(root, ".sessions-perf-results.json");
const fixture = Bun.spawn([process.execPath, path.join(import.meta.dir, "performance-fixture.ts")], {
	stdout: "pipe",
	stderr: "inherit",
});
const fixtureOutput = readLines(fixture.stdout);
const ready = await fixtureOutput.next();
assert.ok(ready.value, "fixture exited before startup");
const startup: unknown = JSON.parse(new TextDecoder().decode(ready.value));
assert.ok(isRecord(startup) && typeof startup.base === "string");
const base = startup.base;
const browser = await puppeteer.launch({
	executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	headless: true,
	args: ["--js-flags=--expose-gc"],
});
const results: object[] = [];
const memory: object[] = [];
function field(value: Record<string, unknown>, key: string): number {
	const number = value[key];
	assert.ok(typeof number === "number" && Number.isFinite(number), `invalid ${key}`);
	return number;
}
async function request(route: string, method = "GET"): Promise<unknown> {
	const response = await fetch(base + route, { method, signal: AbortSignal.timeout(120000) });
	assert.ok(response.ok, `fixture ${route}: ${response.status}`);
	return response.json();
}
async function readState() {
	const value = await request("/fixture/state");
	assert.ok(isRecord(value) && Array.isArray(value.serializers));
	return {
		wireBytes: field(value, "wireBytes"),
		opens: field(value, "opens"),
		pages: field(value, "pages"),
		fullLoads: field(value, "fullLoads"),
		corpusBytes: field(value, "corpusBytes"),
		serializers: value.serializers,
	};
}
async function measure(page: Page, label: string): Promise<void> {
	const state = await readState();
	await page.goto(`${base}/session/0123456789abcdef`);
	await page.waitForSelector('[data-message-key="user:19999:"]', { timeout: 30000 });
	await page.waitForFunction(() => !document.querySelector('[role="status"].banner'), { timeout: 30000 });
	await page.waitForFunction(
		() => {
			const root = document.querySelector<HTMLElement>(".scroll");
			const newest = document.querySelector<HTMLElement>('[data-message-key="user:19999:"]');
			if (!root || !newest || getComputedStyle(newest).visibility !== "visible") return false;
			const viewport = root.getBoundingClientRect();
			const entry = newest.getBoundingClientRect();
			return (
				root.scrollHeight - root.clientHeight - root.scrollTop < 2 &&
				entry.bottom > viewport.top &&
				entry.top < viewport.bottom
			);
		},
		{ timeout: 30000 },
	);
	const paint = await page.evaluate(async () => {
		for (let frame = 0; frame < 2; frame++) {
			const ready = Promise.withResolvers<void>();
			requestAnimationFrame(() => ready.resolve());
			await ready.promise;
		}
		return performance.now();
	});
	const dom = await page.evaluate(() => ({
		nodes: document.querySelectorAll("*").length,
		entries: document.querySelectorAll(".entry").length,
		paint: performance.getEntriesByType("paint").map(e => ({ name: e.name, ms: e.startTime })),
	}));
	const metrics = await page.metrics();
	results.push({
		label,
		newestPaintMs: paint,
		...dom,
		heap: metrics.JSHeapUsedSize,
		wireBytes: (await readState()).wireBytes - state.wireBytes,
	});
}
try {
	console.log(JSON.stringify({ ...startup, pid: process.pid }));
	if (process.env.SESSIONS_PERF_INSPECT === "1") {
		const closed = Promise.withResolvers<void>();
		process.once("SIGTERM", () => closed.resolve());
		process.once("SIGINT", () => closed.resolve());
		await closed.promise;
	} else {
		// Alternate fresh pages on the same corpus; discard the first pair as warm-up.
		const comparePlain = process.env.SESSIONS_PERF_COMPARE_PLAIN !== "0";
		for (let repetition = 0; repetition < 11; repetition++) {
			const labels = comparePlain ? (repetition % 2 ? ["virtual", "plain"] : ["plain", "virtual"]) : ["virtual"];
			for (const label of labels) {
				await request(`/fixture/plain?enabled=${label === "plain" ? 1 : 0}`, "POST");
				const page = await browser.newPage();
				await page.setViewport({ width: 1440, height: 1000 });
				await measure(page, repetition ? label : `warmup-${label}`);
				await page.close();
			}
		}
		await request("/fixture/plain?enabled=0", "POST");
		const page = await browser.newPage();
		await page.setViewport({ width: 390, height: 844 });
		await measure(page, "soak");
		// Hold the older page until the browser has rendered its actual scroll anchor.
		await request("/fixture/hold", "POST");
		const pagesBefore = (await readState()).pages;
		await page.evaluate(() => {
			const node = document.querySelector<HTMLElement>(".scroll")!;
			node.scrollTop = 80;
		});
		await request("/fixture/older");
		await page.waitForSelector(".jump-latest", { timeout: 5000 });
		await page.waitForFunction(() => {
			const root = document.querySelector(".scroll")!.getBoundingClientRect();
			return [...document.querySelectorAll<HTMLElement>("[data-message-key]")].some(
				entry => entry.getBoundingClientRect().bottom > root.top && entry.getBoundingClientRect().top < root.bottom,
			);
		});
		const anchor = await page.evaluate(() => {
			const root = document.querySelector(".scroll")!.getBoundingClientRect();
			const entry = [...document.querySelectorAll<HTMLElement>("[data-message-key]")].find(
				e => e.getBoundingClientRect().bottom > root.top,
			)!;
			return { key: entry.dataset.messageKey!, top: entry.getBoundingClientRect().top };
		});
		await request("/fixture/release", "POST");
		await page.waitForFunction(() => document.querySelector(".scroll")!.scrollTop > 100, { timeout: 30000 });
		assert.ok((await readState()).pages > pagesBefore, "scrolling up must request an older page");
		const anchorAfter = await page.evaluate(
			key =>
				[...document.querySelectorAll<HTMLElement>("[data-message-key]")]
					.find(e => e.dataset.messageKey === key)
					?.getBoundingClientRect().top,
			anchor.key,
		);
		assert.ok(
			anchorAfter !== undefined && Math.abs(anchorAfter - anchor.top) < 4,
			`prepend anchor shifted: ${anchor.top} -> ${anchorAfter}`,
		);
		results.push({ label: "prepend-anchor", before: anchor, after: anchorAfter });
		results.push({ label: "scroll-detach", jumpVisible: true, olderPageRequested: true });
		await page.evaluate(() => document.querySelector<HTMLButtonElement>(".jump-latest")?.click());
		const legacy = await request("/fixture/legacy", "POST");
		assert.ok(Array.isArray(legacy) && legacy.every(isRecord));
		results.push(...legacy);
		const initial = await readState();
		const start = Date.now();
		for (let elapsed = 0; elapsed <= duration; elapsed += 60) {
			const metrics = await page.metrics();
			const rss = await request("/fixture/rss");
			assert.ok(isRecord(rss));
			memory.push({
				seconds: (Date.now() - start) / 1000,
				gatewayRss: field(rss, "gatewayRss"),
				heap: metrics.JSHeapUsedSize,
				opens: (await readState()).opens,
			});
			console.log(JSON.stringify({ event: "sample", ...memory.at(-1) }));
			if (elapsed < duration) await Bun.sleep(Math.min(60, duration - elapsed) * 1000);
		}
		const final = await readState();
		assert.equal(final.opens, initial.opens, "browser must retain its SSE stream throughout the soak");
		const report = {
			durationSeconds: (Date.now() - start) / 1000,
			corpusBytes: final.corpusBytes,
			results,
			serializers: final.serializers,
			memory,
			opensDuringSoak: final.opens - initial.opens,
			fullLoads: final.fullLoads,
			pages: final.pages,
			prependAnchor: "PASS",
		};
		await Bun.write(output, JSON.stringify(report, null, 2));
		console.log(
			JSON.stringify({
				event: "complete",
				output,
				durationSeconds: report.durationSeconds,
				opensDuringSoak: report.opensDuringSoak,
			}),
		);
	}
} catch (cause) {
	await Bun.write(output, JSON.stringify({ error: String(cause), results, memory }, null, 2));
	throw cause;
} finally {
	await browser.close();
	fixture.kill("SIGTERM");
	await fixture.exited;
	await fixtureOutput.return(undefined);
}
