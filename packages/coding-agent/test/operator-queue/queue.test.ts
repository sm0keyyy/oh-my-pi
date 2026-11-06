import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { $ } from "bun";
import { logger } from "@oh-my-pi/pi-utils";
import { acquireLock } from "../../src/operator-queue/lock";
import { ensureDirs, entryPath, queuePaths, queueRoot, type QueuePaths } from "../../src/operator-queue/paths";
import {
	completeInterview,
	enqueueRequest,
	listPending,
	quarantine,
	waitForAnswer,
} from "../../src/operator-queue/queue";
import { writeFileAtomically } from "../../src/utils/atomic-file";

let paths: QueuePaths;
beforeEach(async () => {
	paths = queuePaths(await fs.mkdtemp(path.join(os.tmpdir(), "omp-native-queue-")));
	await ensureDirs(paths);
});
afterEach(async () => {
	await fs.rm(paths.root, { recursive: true, force: true });
});
const questions = [{ id: "go", question: "Proceed?", options: [{ label: "Yes" }] }];

it("keeps same-millisecond requests FIFO across writer processes and accepts legacy records", async () => {
	const created = "2026-11-06T12:00:00.000Z";
	const clock = spyOn(Date.prototype, "toISOString").mockReturnValue(created);
	try {
		await enqueueRequest("z-first", "parent", questions, "main", paths);
		const module = pathToFileURL(path.resolve(import.meta.dir, "../../src/operator-queue/queue.ts")).href;
		const script = `
			import { enqueueRequest } from ${JSON.stringify(module)};
			Date.prototype.toISOString = () => ${JSON.stringify(created)};
			const paths = ${JSON.stringify(paths)};
			const questions = ${JSON.stringify(questions)};
			await enqueueRequest("y-second", "child", questions, "main", paths);
			await enqueueRequest("x-third", "child", questions, "main", paths);
		`;
		await $`${process.execPath} -e ${script}`.quiet();
		await enqueueRequest("a-last", "parent", questions, "main", paths);
		const refs = await listPending(paths);
		expect(refs.map(ref => ref.created)).toEqual([created, created, created, created]);
		expect(refs.map(ref => ref.corrId)).toEqual(["z-first", "y-second", "x-third", "a-last"]);
		for (const id of ["legacy-b", "legacy-a"]) {
			await writeFileAtomically(entryPath(paths.pending, id), JSON.stringify({ id, created, questions }));
		}
		await writeFileAtomically(
			entryPath(paths.pending, "oldest"),
			JSON.stringify({ id: "oldest", created: "2000-01-01T00:00:00Z", questions }),
		);
		expect((await listPending(paths)).map(ref => ref.corrId)).toEqual([
			"oldest",
			"legacy-a",
			"legacy-b",
			"z-first",
			"y-second",
			"x-third",
			"a-last",
		]);
	} finally {
		clock.mockRestore();
	}
});

it("orders by created, quarantines malformed entries, and moves request and answer bytes without copying", async () => {
	const later = await enqueueRequest("a", "fixture", questions, "main", paths);
	await enqueueRequest("z", "fixture", questions, "main", paths);
	await writeFileAtomically(
		entryPath(paths.pending, "z"),
		JSON.stringify({ ...later, id: "z", created: "2000-01-01T00:00:00Z" }),
	);
	await writeFileAtomically(entryPath(paths.pending, "broken"), "{bad");
	const refs = await listPending(paths);
	expect(refs.map(r => r.corrId)).toEqual(["z", "a", "broken"]);
	await quarantine(paths, refs[2]!);
	expect(await Bun.file(entryPath(paths.corrupt, "broken", ".json.err")).text()).toContain("SyntaxError");
	const pending = entryPath(paths.pending, "z");
	const original = await fs.stat(pending);
	expect(await completeInterview(paths, "z", refs[0]!.interview!, { go: { selected: ["Yes"] } })).toBe(true);
	expect((await fs.stat(entryPath(paths.done, "z", ".request.json"))).ino).toBe(original.ino);
	expect(await Bun.file(pending).exists()).toBe(false);
	const answerInode = (await fs.stat(entryPath(paths.answered, "z"))).ino;
	expect(await waitForAnswer("z", 10, undefined, paths)).toMatchObject({
		kind: "answered",
		payload: { answers: { go: { selected: ["Yes"] } } },
	});
	expect((await fs.stat(entryPath(paths.done, "z"))).ino).toBe(answerInode);
	expect(await Bun.file(entryPath(paths.answered, "z")).exists()).toBe(false);
	expect((await fs.readdir(paths.pending)).filter(n => n.endsWith(".tmp"))).toEqual([]);
});

it("never steals a live lock, steals a dead pid, and releases only its own acquisition", async () => {
	const first = crypto.randomUUID();
	const replacement = crypto.randomUUID();
	await Bun.write(paths.lock, JSON.stringify({ owner: "wizard", pid: process.pid, token: first }));
	await fs.utimes(paths.lock, 0, 0);
	expect(await acquireLock(paths, { timeoutMs: 0 })).toBeUndefined();
	await Bun.write(paths.lock, JSON.stringify({ owner: "fixture", pid: 2_147_483_647 }));
	const lock = await acquireLock(paths, { timeoutMs: 0 });
	expect(lock).toBeDefined();
	await Bun.write(paths.lock, JSON.stringify({ owner: "wizard", pid: process.pid, token: replacement }));
	await lock!.release();
	expect(JSON.parse(await Bun.file(paths.lock).text()).token).toBe(replacement);
	await fs.unlink(paths.lock);
	const own = await acquireLock(paths);
	await own!.release();
	expect(await Bun.file(paths.lock).exists()).toBe(false);
});

it("refuses unsafe ids before writing and preserves root override precedence including blank values", async () => {
	for (const id of ["../outside", "", ".", "..", "a/b", "a\\b", "a\0b"])
		await expect(enqueueRequest(id, "fixture", questions, undefined, paths)).rejects.toThrow("unsafe correlation id");
	expect(queueRoot({ ASK_BRIDGE_QUEUE_DIR: "/custom", PI_CODING_AGENT_DIR: "/agent" })).toBe("/custom");
	expect(queueRoot({ ASK_BRIDGE_QUEUE_DIR: "  ", PI_CODING_AGENT_DIR: "/agent" })).toBe("/agent/queue");
	expect(queueRoot({ HOME: "/home/fixture" })).toBe("/home/fixture/.omp/agent/queue");
	expect(await fs.readdir(paths.pending)).toEqual([]);
});

it("skips an unsafe pending filename without hiding valid interviews", async () => {
	await enqueueRequest("valid", "fixture", questions, "main", paths);
	await Bun.write(path.join(paths.pending, ".json"), "{}");
	const warnings = spyOn(logger, "warn");
	try {
		expect((await listPending(paths)).map(ref => ref.corrId)).toEqual(["valid"]);
		expect(warnings).toHaveBeenCalledTimes(1);
		expect(warnings).toHaveBeenCalledWith("operator-queue: skipping pending entry with unsafe correlation id", {
			name: ".json",
		});
	} finally {
		warnings.mockRestore();
	}
});
