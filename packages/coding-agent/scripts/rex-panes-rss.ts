import * as fs from "node:fs/promises";
import { parseArgs } from "node:util";
import { isRecord } from "@oh-my-pi/pi-utils";

type Phase = "baseline" | "during" | "after";
interface Sample {
	at: string;
	pid: number;
	phase: Phase;
	parentKb: number;
	relays: Array<{ pid: number; rssKb: number }>;
}

function positiveInteger(value: string | undefined, name: string): number {
	const number = Number(value);
	if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${name} must be a positive integer`);
	return number;
}

async function sample(pid: number, phase: Phase): Promise<Sample> {
	const processList = Bun.spawn(["ps", "-axo", "pid=,ppid=,rss=,comm="], { stdout: "pipe", stderr: "pipe" });
	const timeout = setTimeout(() => processList.kill(), 5000);
	try {
		const [stdout, stderr, code] = await Promise.all([
			new Response(processList.stdout).text(),
			new Response(processList.stderr).text(),
			processList.exited,
		]);
		if (code !== 0) throw new Error(`ps failed (${code}): ${stderr.trim()}`);
		let parentKb: number | undefined;
		const relays: Sample["relays"] = [];
		for (const line of stdout.split("\n")) {
			const row = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line);
			if (!row) continue;
			if (Number(row[1]) === pid) parentKb = Number(row[3]);
			if (/(?:^|\/)omp-pane-relay(?:-[a-f0-9]+)?$/.test(row[4])) {
				relays.push({ pid: Number(row[1]), rssKb: Number(row[3]) });
			}
		}
		if (parentKb === undefined) throw new Error(`Parent process ${pid} is not running`);
		return { at: new Date().toISOString(), pid, phase, parentKb, relays };
	} finally {
		clearTimeout(timeout);
	}
}

function parseSample(value: unknown): Sample {
	if (
		!isRecord(value) ||
		typeof value.at !== "string" ||
		!Number.isSafeInteger(value.pid) ||
		(value.phase !== "baseline" && value.phase !== "during" && value.phase !== "after") ||
		typeof value.parentKb !== "number" ||
		!Number.isFinite(value.parentKb) ||
		value.parentKb <= 0 ||
		!Array.isArray(value.relays) ||
		!value.relays.every(
			relay =>
				isRecord(relay) &&
				Number.isSafeInteger(relay.pid) &&
				typeof relay.rssKb === "number" &&
				Number.isFinite(relay.rssKb) &&
				relay.rssKb >= 0,
		)
	) {
		throw new Error("Invalid RSS sample");
	}
	return value as unknown as Sample;
}

function median(values: number[]): number {
	if (values.length === 0) throw new Error("Each RSS phase needs samples");
	values.sort((a, b) => a - b);
	const middle = Math.floor(values.length / 2);
	return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
}

async function main(): Promise<void> {
	const { values, positionals } = parseArgs({
		args: Bun.argv.slice(2),
		allowPositionals: true,
		options: {
			pid: { type: "string" },
			phase: { type: "string" },
			seconds: { type: "string" },
			out: { type: "string" },
			panes: { type: "string" },
		},
	});
	if (positionals[0] === "sample") {
		const pid = positiveInteger(values.pid, "--pid");
		const seconds = positiveInteger(values.seconds ?? "30", "--seconds");
		const phase = values.phase;
		if (phase !== "baseline" && phase !== "during" && phase !== "after")
			throw new Error("--phase must be baseline, during, or after");
		if (!values.out) throw new Error("--out is required");
		const out = await fs.open(values.out, "a", 0o600);
		try {
			for (let second = 0; second < seconds; second++) {
				const started = performance.now();
				await out.appendFile(`${JSON.stringify(await sample(pid, phase))}\n`);
				if (second + 1 < seconds) await Bun.sleep(Math.max(0, 1000 - (performance.now() - started)));
			}
		} finally {
			await out.close();
		}
		return;
	}
	if (positionals[0] !== "report" || !positionals[1])
		throw new Error(
			"Use sample --pid PID --phase baseline|during|after --seconds 30 --out rss.jsonl, or report rss.jsonl --panes 3",
		);
	const panes = positiveInteger(values.panes, "--panes");
	const samples = (await Bun.file(positionals[1]).text())
		.trim()
		.split("\n")
		.filter(Boolean)
		.map(line => parseSample(JSON.parse(line)));
	if (new Set(samples.map(row => row.pid)).size !== 1) throw new Error("RSS samples must describe one parent process");
	const phases = Object.fromEntries(
		(["baseline", "during", "after"] as const).map(phase => [
			phase,
			median(samples.filter(row => row.phase === phase).map(row => row.parentKb)) / 1024,
		]),
	) as Record<Phase, number>;
	const perPaneMb = (phases.during - phases.baseline) / panes;
	const afterDeltaMb = phases.after - phases.baseline;
	const relaySamples = samples.flatMap(row => row.relays);
	const maxRelayMb = relaySamples.reduce((max, row) => Math.max(max, row.rssKb / 1024), 0);
	const pass = relaySamples.length > 0 && perPaneMb <= 50 && maxRelayMb <= 5 && afterDeltaMb <= 25;
	console.log(
		JSON.stringify(
			{
				medianParentMb: phases,
				perPaneMb,
				afterDeltaMb,
				maxRelayMb,
				result: pass ? "PASS" : "FAIL",
				samples: samples.length,
			},
			null,
			2,
		),
	);
	if (!pass) process.exitCode = 1;
}

await main().catch(error => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
