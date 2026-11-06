import { afterEach, beforeEach, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { ensureDirs, entryPath, queuePaths } from "../../src/operator-queue/paths";
import { completeInterview, listPending } from "../../src/operator-queue/queue";

const extensions = path.join(os.homedir(), ".omp", "agent", "extensions");
const bridge = path.join(extensions, "ask-bridge", "lib", "queue.ts");
const wizard = path.join(extensions, "wizard", "src", "queue.ts");
const goCheck = path.join(os.homedir(), "Developer", "tools", "agent-kit", "bin", "go-check");
let root: string;
let previous: string | undefined;
beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cross-queue-"));
	previous = process.env.ASK_BRIDGE_QUEUE_DIR;
	process.env.ASK_BRIDGE_QUEUE_DIR = path.join(root, "queue");
	await ensureDirs(queuePaths());
});
afterEach(async () => {
	if (previous === undefined) delete process.env.ASK_BRIDGE_QUEUE_DIR;
	else process.env.ASK_BRIDGE_QUEUE_DIR = previous;
	await fs.rm(root, { recursive: true, force: true });
});

async function externalModule(module: string, body: string): Promise<string> {
	const script = path.join(root, `${crypto.randomUUID()}.ts`);
	await Bun.write(script, `import * as queue from ${JSON.stringify(pathToFileURL(module).href)};\n${body}\n`);
	const child = Bun.spawn([process.execPath, script], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code !== 0) throw new Error(`External queue consumer exited ${code}: ${stderr}`);
	return stdout;
}

it("reads real ask-bridge and wizard pending bytes and publishes answers both real consumers accept", async () => {
	const questions = [
		{ id: "go", question: "Install fixture build?", options: [{ label: "Yes" }, { label: "No" }], recommended: 1 },
	];
	await externalModule(
		bridge,
		`queue.enqueueRequest("bridge-receipt", "fixture", ${JSON.stringify(questions)}, "main");`,
	);
	await externalModule(
		wizard,
		`queue.writePending({id:"wizard-receipt", from:"fixture", created:new Date().toISOString(), session:"main", questions:${JSON.stringify(questions)}});`,
	);
	const paths = queuePaths();
	const refs = await listPending(paths);
	expect(refs.map(r => r.corrId).sort()).toEqual(["bridge-receipt", "wizard-receipt"]);
	for (const ref of refs) {
		expect(ref.corrupt).toBeUndefined();
		expect(ref.interview?.session).toBe("main");
		const requestBytes = await Bun.file(ref.file).text();
		await completeInterview(paths, ref.corrId, ref.interview!, { go: { selected: ["Yes"] } }, "native receipt");
		expect(await Bun.file(entryPath(paths.done, ref.corrId, ".request.json")).text()).toBe(requestBytes);
		const pickedUp = JSON.parse(
			await externalModule(
				wizard,
				`console.log(JSON.stringify(queue.readAnswered(${JSON.stringify(ref.corrId)})));`,
			),
		);
		expect(pickedUp).toEqual({ id: ref.corrId, answers: { go: { selected: ["Yes"] } }, note: "native receipt" });
		const child = Bun.spawn([goCheck, ref.corrId, "--expect", "go=Install fixture build?"], {
			env: { ...process.env },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
		expect(JSON.parse(stdout)).toMatchObject({ ok: true, result: { ask: ref.corrId, answers: { go: ["Yes"] } } });
	}
});
