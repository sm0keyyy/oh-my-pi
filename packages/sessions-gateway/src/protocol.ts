import { isRecord } from "@oh-my-pi/pi-utils/type-guards";
import type { RpcSessionSnapshot } from "../../coding-agent/src/modes/rpc/rpc-types";
import { MAX_RPC_FRAME_BYTES } from "../../coding-agent/src/modes/rpc/rpc-frame";

export const PUBLIC_ORIGIN = "https://sessions.the-freed.family";
export const HEARTBEAT_MS = 30_000;
export const SNAPSHOT_MS = 10_000;
export const IDLE_MS = 120_000;
export const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;
export const INSTANCE_ID = /^[a-f0-9]{16}$/;
export const TOKEN = /^[A-Za-z0-9_-]{32,128}$/;
export type ClosedCode = "not_found" | "unreachable" | "tui_exited";
export type GatewayEvent = "attached" | "bridge_offline" | "session_gone" | "session_unavailable";
export type GatewayMessage =
	| { t: "ready" }
	| { t: "attach"; conn: string; instanceId: string }
	| { t: "frame"; conn: string; line: string }
	| { t: "detach"; conn: string };
export type BridgeMessage =
	| { t: "sessions"; sessions: RpcSessionSnapshot[]; gone?: string[] }
	| { t: "frame"; conn: string; line: string }
	| { t: "closed"; conn: string; code: ClosedCode };

export function isRpcLine(line: unknown): line is string {
	return (
		typeof line === "string" &&
		line.length > 0 &&
		!line.includes("\n") &&
		!line.includes("\r") &&
		Buffer.byteLength(line) + 1 <= MAX_RPC_FRAME_BYTES
	);
}

const SAFE_DIAGNOSTICS: Record<string, true> = {
	"": true,
	bridge_offline: true,
	session_gone: true,
	session_unavailable: true,
	"a bridge is already connected": true,
	"text frames required": true,
	"invalid RPC line": true,
	"idle timeout": true,
	"gateway silent": true,
	"bridge stopped": true,
	"gateway stopped": true,
	"connect timeout": true,
	"transport error": true,
	"invalid gateway message": true,
	"invalid bridge message": true,
	"Invalid gateway envelope": true,
	"Invalid gateway message": true,
	"Invalid bridge message": true,
	"Invalid session snapshot": true,
	"Duplicate session id": true,
	"Invalid connection id": true,
	"Gateway payload exceeds the limit": true,
	"Invalid gone session ids": true,
	"Discovery directory is not private": true,
	"Invalid discovery file": true,
	"Invalid discovery metadata": true,
	"Invalid socket ready": true,
	"RPC discovery directory is not private": true,
};

export function sanitizeDiagnostic(value: unknown): string {
	if (value instanceof SyntaxError) return "invalid JSON";
	if (value instanceof Error) {
		const code = "code" in value ? value.code : undefined;
		if (
			typeof code === "string" &&
			["ENOENT", "EACCES", "EPERM", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ESRCH"].includes(code)
		)
			return code;
		return Object.hasOwn(SAFE_DIAGNOSTICS, value.message) ? value.message : "redacted";
	}
	return typeof value === "string" && Object.hasOwn(SAFE_DIAGNOSTICS, value) ? value : "redacted";
}

function parseEnvelope(text: string): Record<string, unknown> {
	if (Buffer.byteLength(text) > MAX_PAYLOAD_BYTES) throw new Error("Gateway payload exceeds the limit");
	const value: unknown = JSON.parse(text);
	if (!isRecord(value)) throw new Error("Invalid gateway envelope");
	return value;
}

function parseSnapshot(value: unknown): RpcSessionSnapshot {
	if (
		!isRecord(value) ||
		typeof value.instanceId !== "string" ||
		!INSTANCE_ID.test(value.instanceId) ||
		typeof value.pid !== "number" ||
		!Number.isSafeInteger(value.pid) ||
		value.pid <= 0 ||
		typeof value.sessionId !== "string" ||
		typeof value.cwd !== "string" ||
		(value.sessionName !== undefined && typeof value.sessionName !== "string") ||
		typeof value.busy !== "boolean" ||
		typeof value.inputRequired !== "boolean" ||
		(value.questionText !== undefined && typeof value.questionText !== "string") ||
		typeof value.startedAt !== "number" ||
		!Number.isSafeInteger(value.startedAt) ||
		value.startedAt < 0 ||
		typeof value.lastActivity !== "number" ||
		!Number.isSafeInteger(value.lastActivity) ||
		value.lastActivity < 0 ||
		(value.model !== undefined &&
			(!isRecord(value.model) ||
				typeof value.model.id !== "string" ||
				typeof value.model.provider !== "string" ||
				typeof value.model.api !== "string"))
	) {
		throw new Error("Invalid session snapshot");
	}
	return {
		instanceId: value.instanceId,
		pid: value.pid,
		sessionId: value.sessionId,
		sessionName: value.sessionName,
		cwd: value.cwd,
		model: value.model as RpcSessionSnapshot["model"],
		busy: value.busy,
		inputRequired: value.inputRequired,
		questionText: value.questionText,
		startedAt: value.startedAt,
		lastActivity: value.lastActivity,
	};
}

function connection(value: Record<string, unknown>): string {
	if (typeof value.conn !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value.conn))
		throw new Error("Invalid connection id");
	return value.conn;
}

export function parseGatewayMessage(text: string): GatewayMessage {
	const value = parseEnvelope(text);
	if (value.t === "ready") return { t: "ready" };
	const conn = connection(value);
	if (value.t === "attach" && typeof value.instanceId === "string" && INSTANCE_ID.test(value.instanceId)) {
		return { t: "attach", conn, instanceId: value.instanceId };
	}
	if (value.t === "frame" && isRpcLine(value.line)) return { t: "frame", conn, line: value.line };
	if (value.t === "detach") return { t: "detach", conn };
	throw new Error("Invalid gateway message");
}

export function parseBridgeMessage(text: string): BridgeMessage {
	const value = parseEnvelope(text);
	if (value.t === "sessions" && Array.isArray(value.sessions)) {
		const sessions = value.sessions.map(parseSnapshot);
		if (new Set(sessions.map(session => session.instanceId)).size !== sessions.length)
			throw new Error("Duplicate session id");
		if (
			value.gone !== undefined &&
			(!Array.isArray(value.gone) ||
				value.gone.some(id => typeof id !== "string" || !INSTANCE_ID.test(id)) ||
				new Set(value.gone).size !== value.gone.length ||
				value.gone.some(id => sessions.some(session => session.instanceId === id)))
		)
			throw new Error("Invalid gone session ids");
		return { t: "sessions", sessions, ...(value.gone === undefined ? {} : { gone: value.gone as string[] }) };
	}
	const conn = connection(value);
	if (value.t === "frame" && isRpcLine(value.line)) return { t: "frame", conn, line: value.line };
	if (
		value.t === "closed" &&
		(value.code === "not_found" || value.code === "unreachable" || value.code === "tui_exited")
	) {
		return { t: "closed", conn, code: value.code };
	}
	throw new Error("Invalid bridge message");
}
