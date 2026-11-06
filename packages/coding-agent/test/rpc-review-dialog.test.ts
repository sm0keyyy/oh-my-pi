import { expect, test } from "bun:test";
import * as net from "node:net";
import { isRecord, TempDir } from "@oh-my-pi/pi-utils";
import type { ExtensionReviewRequest } from "../src/extensibility/extensions/types";
import { requestRpcReview, RpcExtensionUIContext, type PendingExtensionRequest } from "../src/modes/rpc/rpc-mode";
import { MAX_RPC_FRAME_BYTES } from "../src/modes/rpc/rpc-frame";
import { startRpcSocketServer } from "../src/modes/rpc/rpc-socket";
import { createAgentSession } from "../src/sdk";
import { Settings } from "../src/config/settings";

const request: ExtensionReviewRequest = {
	path: "/tmp/plan.md",
	title: "Plan",
	markdown: "x".repeat(900 * 1024),
	sections: [{ id: "§4", heading: "Slices", excerpt: "merge view and wire" }],
};
test("review sends bounded excerpts, not markdown, and accepts only a valid verdict or cancellation", async () => {
	const pending = new Map<string, PendingExtensionRequest>();
	const frames: object[] = [];
	const ui = new RpcExtensionUIContext(pending, frame => frames.push(frame));
	expect(ui.review).toBeUndefined();
	ui.reviewDialogEnabled = true;
	const answer = ui.review!(request);
	const frame = frames[0];
	if (!isRecord(frame) || typeof frame.id !== "string") throw new Error("Missing review request");
	expect(frame).toMatchObject({ method: "review", path: request.path, title: "Plan", sections: request.sections });
	expect(frame).not.toHaveProperty("markdown");
	expect(Buffer.byteLength(JSON.stringify(frame))).toBeLessThan(MAX_RPC_FRAME_BYTES);
	pending.get(frame.id)?.resolve({
		type: "extension_ui_response",
		id: frame.id,
		review: { verdict: "request-changes", comments: [{ section: "§4 Slices", text: "merge view and wire" }] },
	});
	expect(await answer).toEqual({
		kind: "verdict",
		verdict: "request-changes",
		comments: [{ section: "§4 Slices", text: "merge view and wire" }],
	});
	const cancelled = requestRpcReview(
		pending,
		frame => {
			if (isRecord(frame) && typeof frame.id === "string")
				pending.get(frame.id)?.resolve({ type: "extension_ui_response", id: frame.id, cancelled: true });
		},
		request,
	);
	expect(await cancelled).toEqual({ kind: "cancelled" });
	const invalid = requestRpcReview(
		pending,
		frame => {
			if (isRecord(frame) && typeof frame.id === "string")
				pending.get(frame.id)?.resolve({
					type: "extension_ui_response",
					id: frame.id,
					review: { verdict: "approve", comments: [{ section: "foreign", text: "note" }] },
				});
		},
		request,
	);
	await expect(invalid).rejects.toThrow("Invalid review comment");
});

test("socket enables review on connect and raceDialog lets remote answer win and abort local", async () => {
	await using temp = await TempDir.create("@rpc-review-socket-");
	const { session } = await createAgentSession({
		cwd: temp.path(),
		agentDir: temp.join("agent"),
		toolNames: [],
		enableMCP: false,
		enableLsp: false,
		disableExtensionDiscovery: true,
		settings: Settings.isolated({ "compaction.enabled": false }),
	});
	const server = await startRpcSocketServer(session, {}, { dir: temp.join("rpc") });
	const meta = await Bun.file(temp.join("rpc", `${server.instanceId}.json`)).json();
	const socket = net.createConnection(server.endpoint);
	socket.setEncoding("utf8");
	let buffer = "";
	const ready = Promise.withResolvers<void>();
	socket.on("data", chunk => {
		buffer += chunk;
		let newline: number;
		while ((newline = buffer.indexOf("\n")) >= 0) {
			const frame: unknown = JSON.parse(buffer.slice(0, newline));
			buffer = buffer.slice(newline + 1);
			if (!isRecord(frame)) continue;
			if (frame.type === "available_commands_update") ready.resolve();
			if (frame.method === "review")
				socket.write(
					`${JSON.stringify({ type: "extension_ui_response", id: frame.id, review: { verdict: "approve", comments: [] } })}\n`,
				);
		}
	});
	socket.write(`${JSON.stringify({ type: "hello", token: meta.token })}\n`);
	try {
		await ready.promise;
		let aborted = false;
		const result = await server.raceDialog(
			signal => {
				signal.addEventListener("abort", () => {
					aborted = true;
				});
				return Promise.withResolvers<never>().promise;
			},
			(ui, signal) => ui.review?.(request, { signal }),
			undefined,
			"Approve Plan?",
		);
		expect(result).toEqual({ kind: "verdict", verdict: "approve", comments: [] });
		expect(aborted).toBe(true);
		expect(server.inputRequired).toBe(false);
	} finally {
		socket.destroy();
		await server.close();
		await session.dispose();
	}
}, 30000);
