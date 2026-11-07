import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isRecord, ptree } from "@oh-my-pi/pi-utils";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { bdEnvironment, parseBeads } from "../src/beads";
import { RpcClient } from "../src/modes/rpc/rpc-client";
import { isTodoPhase } from "../src/tools/todo";

const [directory, phasesFile] = process.argv.slice(2);
if (!directory || directory === "--help") {
	process.stdout.write(
		"Usage: bun scripts/beads-live.ts <scratch-repo> [phases.json]\nUses dist/omp and bd from PATH; never sends a prompt.\n",
	);
	process.exit(directory ? 0 : 1);
}
const cwd = await fs.realpath(directory);
const input: unknown = phasesFile
	? await Bun.file(phasesFile).json()
	: [{ name: "Probe", tasks: [{ content: "Check beads persistence", status: "pending" }] }];
if (!Array.isArray(input) || !input.every(isTodoPhase)) throw new Error("phases.json must contain todo phases");
const phases: TodoPhase[] = input;
const home = await fs.mkdtemp(path.join(os.tmpdir(), "omp-beads-live-"));
const overlay = path.join(home, "overlay.yml");
const binary = path.resolve(import.meta.dir, "../dist/omp");
const env = {
	HOME: home,
	PATH: process.env.PATH ?? "",
	PI_CODING_AGENT_DIR: path.join(home, ".omp"),
	DO_NOT_TRACK: "1",
	NO_COLOR: "1",
	NODE_ENV: "production",
	PI_TEST_RUNTIME: "0",
};
let providerRequests = 0;
const provider = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch: () => {
		providerRequests++;
		return Response.json({ error: "This receipt must not call a provider" }, { status: 500 });
	},
});
const client = new RpcClient({
	cwd,
	provider: "beads-fixture",
	model: "probe",
	spawn: args => ptree.spawn([binary, ...args], { cwd, env, stdin: "pipe" }),
	args: ["--config", overlay, "--no-session", "--no-extensions", "--no-skills", "--no-rules", "--no-context-files"],
});
try {
	await Bun.write(
		path.join(home, ".omp/models.yml"),
		JSON.stringify({
			providers: {
				"beads-fixture": {
					baseUrl: `http://127.0.0.1:${provider.port}/v1`,
					api: "openai-completions",
					apiKey: "unused-beads-live-fixture",
					models: [{ id: "probe", name: "Beads RPC fixture" }],
				},
			},
		}),
	);
	await Bun.write(
		overlay,
		JSON.stringify({
			todo: { store: "beads", beads: { roots: [cwd], globalDir: path.join(home, "global") } },
		}),
	);
	await client.start();
	const setTodos = await client.setTodos(phases);
	const ids = setTodos
		.flatMap(phase => [phase.id, ...phase.tasks.map(task => task.id)])
		.filter((id): id is string => !!id);
	if (ids.length !== setTodos.length + setTodos.reduce((sum, phase) => sum + phase.tasks.length, 0))
		throw new Error("RPC set_todos returned missing bead IDs");
	const deadline = Date.now() + 30_000;
	let bd: unknown;
	while (true) {
		const result = await ptree.exec(["bd", "--readonly", "list", "--all", "-n", "0", "--json"], {
			cwd,
			env: bdEnvironment(cwd, env),
			timeout: 10_000,
			allowNonZero: true,
		});
		if (result.exitCode === 0) {
			const raw: unknown = JSON.parse(result.stdout);
			bd = isRecord(raw) && "data" in raw ? raw.data : raw;
			const beads = parseBeads(bd);
			if (ids.every(id => beads.some(bead => bead.id === id))) break;
		}
		if (Date.now() >= deadline) throw new Error(`Beads did not contain the RPC snapshot: ${result.stderr}`);
		await Bun.sleep(100);
	}
	const state = await client.getState();
	if (providerRequests !== 0) throw new Error("The RPC receipt made an unexpected provider call");
	process.stdout.write(`${JSON.stringify({ set_todos: setTodos, get_state: state, bd })}\n`);
} finally {
	try {
		await client.stop();
	} finally {
		provider.stop(true);
		await fs.rm(home, { recursive: true, force: true });
	}
}
