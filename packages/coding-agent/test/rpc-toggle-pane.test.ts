import { expect, test } from "bun:test";
import { isRecord, TempDir } from "@oh-my-pi/pi-utils";
import { createRpcConnection, type RpcHostAdapter } from "../src/modes/rpc/rpc-mode";
import { createAgentSession } from "../src/sdk";
import { Settings } from "../src/config/settings";

test("toggle_pane delegates to host, rejects invalid input, and reports an unsupported host; review is opt-in", async () => {
	await using temp = await TempDir.create("@rpc-toggle-");
	const { session } = await createAgentSession({
		cwd: temp.path(),
		agentDir: temp.join("agent"),
		toolNames: [],
		enableMCP: false,
		enableLsp: false,
		disableExtensionDiscovery: true,
		settings: Settings.isolated({ "compaction.enabled": false }),
	});
	const encoder = new TextEncoder();
	let input!: ReadableStreamDefaultController<Uint8Array>;
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			input = controller;
		},
	});
	const responses = new Map<string, (frame: Record<string, unknown>) => void>();
	const host: RpcHostAdapter = {};
	const connection = await createRpcConnection({
		session,
		host,
		input: stream,
		writer: {
			write(value) {
				for (const line of value) {
					if (!line) continue;
					const frame: unknown = JSON.parse(line);
					if (isRecord(frame) && typeof frame.id === "string") responses.get(frame.id)?.(frame);
				}
			},
		},
	});
	let sequence = 0;
	const send = async (command: object) => {
		const id = String(sequence++);
		const result = Promise.withResolvers<Record<string, unknown>>();
		responses.set(id, result.resolve);
		input.enqueue(encoder.encode(`${JSON.stringify({ ...command, id })}\n`));
		try {
			return await result.promise;
		} finally {
			responses.delete(id);
		}
	};
	try {
		expect(connection.uiContext.review).toBeUndefined();
		expect(await send({ type: "set_review_dialog", enabled: true })).toMatchObject({
			success: true,
			data: { enabled: true },
		});
		expect(typeof connection.uiContext.review).toBe("function");
		expect(await send({ type: "set_review_dialog", enabled: false })).toMatchObject({ data: { enabled: false } });
		expect(connection.uiContext.review).toBeUndefined();
		expect(await send({ type: "toggle_pane", pane: "todo" })).toMatchObject({
			success: false,
			error: "toggle_pane needs the interactive TUI in Rex",
		});
		let open = false;
		host.handleCommand = async command => {
			if (command.type !== "toggle_pane") return undefined;
			expect(command).toMatchObject({ pane: "agents", shape: "float" });
			open = !open;
			return { id: command.id, type: "response", command: "toggle_pane", success: true, data: { open } };
		};
		expect(await send({ type: "toggle_pane", pane: "agents", shape: "float" })).toMatchObject({
			success: true,
			data: { open: true },
		});
		expect(await send({ type: "toggle_pane", pane: "agents", shape: "float" })).toMatchObject({
			data: { open: false },
		});
		expect(await send({ type: "toggle_pane", pane: "invalid" })).toMatchObject({ success: false });
	} finally {
		input.close();
		await connection.done;
		await connection.dispose();
		await session.dispose();
	}
}, 30000);
