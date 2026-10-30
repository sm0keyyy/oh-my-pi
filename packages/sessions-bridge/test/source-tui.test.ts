import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isRecord } from "@oh-my-pi/pi-utils";
import { PUBLIC_ORIGIN } from "../../sessions-gateway/src/protocol";
import { startGateway } from "../../sessions-gateway/src/server";
import { createAccessFixture } from "../../sessions-gateway/test/access-fixture";
import { Peer } from "../../sessions-gateway/test/peer";
import { startBridge } from "../src/bridge";

test("relays three authenticated browser attachments to an isolated source-run TUI and confirms its exit", async () => {
	const root = path.resolve(import.meta.dir, "../../..");
	const config = await fs.mkdtemp(path.join(import.meta.dir, "../.source-tui-test-"));
	const agentDir = path.join(config, "agent");
	await fs.mkdir(agentDir, { mode: 0o700 });
	await Bun.write(
		path.join(agentDir, "config.yml"),
		"collab:\n  autoStart: off\nrpcSocket:\n  enabled: true\nspelling:\n  autocomplete: off\n",
	);
	await Bun.write(
		path.join(agentDir, "models.yml"),
		"providers:\n  fake:\n    baseUrl: http://127.0.0.1:9/v1\n    auth: none\n    api: openai-completions\n    models:\n      - id: gpt-4.1\n        name: Local Model\n        reasoning: false\n        input: [text]\n        contextWindow: 128000\n        maxTokens: 8192\n",
	);
	const siteDir = path.join(config, "site");
	await Bun.write(path.join(siteDir, "index.html"), "<html>isolated relay test</html>");
	const access = await createAccessFixture();
	const token = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
	const gateway = await startGateway({
		token,
		siteDir,
		hostname: "127.0.0.1",
		port: 0,
		accessCertsUrl: access.certsUrl,
	});
	const bridge = startBridge({
		url: gateway.url + "/events/bridge",
		headers: { ...access.serviceHeaders, authorization: `Bearer ${token}` },
		dir: path.join(config, "run/rpc-sessions"),
	});
	const child = Bun.spawn(
		[
			process.execPath,
			path.join(root, "packages/coding-agent/src/cli.ts"),
			"--model",
			"fake/gpt-4.1",
			"--no-skills",
			"--no-rules",
			"--no-title",
			"--no-lsp",
			"--no-extensions",
		],
		{
			cwd: config,
			env: {
				PATH: process.env.PATH,
				HOME: os.homedir(),
				TMPDIR: process.env.TMPDIR,
				LANG: "en_US.UTF-8",
				PI_CONFIG_DIR: path.relative(os.homedir(), config),
				PI_CODING_AGENT_DIR: agentDir,
				PI_NO_TITLE: "1",
				TERM: "xterm-256color",
				COLORTERM: "truecolor",
			},
			terminal: {
				cols: 120,
				rows: 40,
				data(terminal, data) {
					if (new TextDecoder().decode(data).includes("\x1b[6n")) terminal.write("\x1b[40;1R");
				},
			},
		},
	);
	const peers: Peer[] = [];
	try {
		// Discovery crosses a real child-process boundary; wait for its published snapshot.
		let instanceId: string | undefined;
		const deadline = Date.now() + 20_000;
		while (!instanceId && Date.now() < deadline) {
			const body: unknown = await (await access.fetch(`${gateway.url}/api/sessions`)).json();
			if (isRecord(body) && Array.isArray(body.sessions)) {
				const session: unknown = body.sessions[0];
				if (isRecord(session) && typeof session.instanceId === "string") instanceId = session.instanceId;
			}
			if (!instanceId) await Bun.sleep(20);
		}
		if (!instanceId) throw new Error(`Source TUI did not publish: ${child.exitCode}`);
		const lobby = await (await access.fetch(`${gateway.url}/api/sessions`)).json();
		expect(lobby).toMatchObject({ sessions: [{ pid: child.pid }] });
		for (let index = 0; index < 3; index++) {
			const peer = new Peer(`${gateway.url}/events/session/${instanceId}`, {
				...access.headers,
				origin: PUBLIC_ORIGIN,
			});
			peers.push(peer);
			let ready = JSON.parse(await peer.next());
			while (ready.type !== "ready") ready = JSON.parse(await peer.next());
			expect(ready.type).toBe("ready");
			expect(ready.host.pid).toBe(child.pid);
			expect((await peer.send(JSON.stringify({ id: `state-${index}`, type: "get_state" }))).status).toBe(200);
			for (;;) {
				const frame = JSON.parse(await peer.next());
				if (frame.id !== `state-${index}`) continue;
				expect(frame.success).toBe(true);
				expect(frame.data.rpcSession.instanceId).toBe(instanceId);
				break;
			}
		}
		child.kill("SIGINT");
		await child.exited;
		const attachedCount = peers.length;
		for (let index = 0; index < attachedCount; index++) {
			const peer = peers[index]!;
			for (;;) {
				const frame = JSON.parse(await peer.next());
				if (frame.type !== "gateway") continue;
				if (frame.event === "session_unavailable" || frame.event === "resync") continue;
				expect(frame.event).toBe("session_gone");
				break;
			}
		}
	} finally {
		for (const peer of peers) peer.close();
		bridge.stop();
		gateway.stop();
		access.stop();
		if (child.exitCode === null) child.kill("SIGKILL");
		await child.exited;
		child.terminal?.close();
		await fs.rm(config, { recursive: true });
	}
}, 30_000);
