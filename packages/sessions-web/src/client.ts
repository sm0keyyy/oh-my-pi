import { isRecord } from "@oh-my-pi/web-render";
import { ThinkingLevel, terminalCommands, type RpcCommand, type RpcExtensionUIResponse } from "./commands";

export type RecordValue = Record<string, unknown>;
export interface Message extends RecordValue {
	role: string;
	key: string;
}
export interface Snapshot {
	phase: "connecting" | "rebuilding" | "connected" | "offline" | "gone" | "closed";
	state: RecordValue;
	messages: Message[];
	dialogs: RecordValue[];
	commands: RecordValue[];
	models: RecordValue[];
	levels: string[];
	agents: RecordValue[];
	agentMessages: Record<string, Message[]>;
	tools: Record<string, RecordValue>;
	statuses: Record<string, string>;
	widgets: Record<string, string[]>;
	notices: string[];
	stats: RecordValue;
	error: string | null;
	lastFrame: number;
	revision: number;
	editorText?: { text: string; version: number };
}
interface Pending {
	command: string;
	resolve(value: RecordValue): void;
	reject(error: Error): void;
	timer: number;
}
export function records(value: unknown): RecordValue[] {
	if (!Array.isArray(value) || !value.every(isRecord)) throw new Error("Expected an object list from the TUI");
	return value;
}
export function strings(value: unknown): string[] {
	if (!Array.isArray(value) || !value.every(v => typeof v === "string"))
		throw new Error("Expected a text list from the TUI");
	return value;
}
export function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}
export function number(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
export function messageOf(value: unknown, fallback: string): Message {
	if (!isRecord(value) || typeof value.role !== "string") throw new Error("Invalid TUI message");
	return { ...value, role: value.role, key: `${value.role}:${value.timestamp ?? fallback}:${value.toolCallId ?? ""}` };
}
export function messageText(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map(v => (isRecord(v) ? text(v.text) || text(v.thinking) : "")).join("");
	if (isRecord(value))
		return messageText(value.content) || text(value.text) || text(value.output) || text(value.summary);
	return "";
}
export function sortSessions(value: unknown): RecordValue[] {
	return records(value)
		.map(session => {
			if (
				typeof session.instanceId !== "string" ||
				!/^[a-f0-9]{16}$/.test(session.instanceId) ||
				typeof session.cwd !== "string" ||
				typeof session.busy !== "boolean" ||
				typeof session.inputRequired !== "boolean" ||
				(session.questionText !== undefined && typeof session.questionText !== "string") ||
				typeof session.lastActivity !== "number" ||
				typeof session.startedAt !== "number"
			)
				throw new Error("Invalid session snapshot");
			return session;
		})
		.sort(
			(a, b) =>
				Number(b.inputRequired) - Number(a.inputRequired) ||
				number(b.lastActivity) - number(a.lastActivity) ||
				text(a.instanceId).localeCompare(text(b.instanceId)),
		);
}

export class FrameDecoder {
	#pending?: { id: string; count: number; size: number; index: number; bytes: Uint8Array; offset: number };
	push(line: string): RecordValue | undefined {
		if (new TextEncoder().encode(line).byteLength > 1024 * 1024) throw new Error("RPC frame is too large");
		const value: unknown = JSON.parse(line);
		if (!isRecord(value) || typeof value.type !== "string") throw new Error("Invalid RPC frame");
		if (value.type !== "rpc_chunk") {
			if (this.#pending) throw new Error("Interrupted RPC chunks");
			return value;
		}
		const { chunkId, index, count, byteLength, data } = value;
		if (
			typeof chunkId !== "string" ||
			chunkId.length === 0 ||
			chunkId.length > 128 ||
			typeof index !== "number" ||
			typeof count !== "number" ||
			typeof byteLength !== "number" ||
			!Number.isSafeInteger(index) ||
			!Number.isSafeInteger(count) ||
			!Number.isSafeInteger(byteLength) ||
			count < 2 ||
			count > 256 ||
			index < 0 ||
			index >= count ||
			byteLength < 1024 * 1024 ||
			byteLength > 64 * 1024 * 1024 ||
			typeof data !== "string" ||
			!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)
		)
			throw new Error("Invalid RPC chunk");
		const decoded = atob(data);
		if (decoded.length === 0 || decoded.length > 256 * 1024 || btoa(decoded) !== data)
			throw new Error("Invalid RPC chunk data");
		if (!this.#pending) {
			if (index !== 0) throw new Error("RPC chunks start at zero");
			this.#pending = {
				id: chunkId,
				count,
				size: byteLength,
				index: 0,
				bytes: new Uint8Array(byteLength),
				offset: 0,
			};
		}
		const pending = this.#pending;
		if (
			pending.id !== chunkId ||
			pending.count !== count ||
			pending.size !== byteLength ||
			pending.index !== index ||
			pending.offset + decoded.length > byteLength
		)
			throw new Error("RPC chunk sequence mismatch");
		for (let i = 0; i < decoded.length; i++) pending.bytes[pending.offset + i] = decoded.charCodeAt(i);
		pending.offset += decoded.length;
		pending.index++;
		if (pending.index < count) return;
		this.#pending = undefined;
		if (pending.offset !== byteLength) throw new Error("RPC chunk length mismatch");
		const frame: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(pending.bytes));
		if (!isRecord(frame) || typeof frame.type !== "string") throw new Error("Invalid reassembled RPC frame");
		return frame;
	}
}

export class SessionClient {
	#socket?: WebSocket;
	#listeners = new Set<() => void>();
	#pending = new Map<string, Pending>();
	#decoder = new FrameDecoder();
	#retry?: number;
	#refresh?: number;
	#deadline?: number;
	#backoff = 1000;
	#stopped = false;
	#generation = 0;
	#hydration = 0;
	#events: RecordValue[] | null = null;
	#snapshot: Snapshot = {
		phase: "connecting",
		state: {},
		messages: [],
		dialogs: [],
		commands: [],
		models: [],
		levels: [],
		agents: [],
		agentMessages: {},
		tools: {},
		statuses: {},
		widgets: {},
		notices: [],
		stats: {},
		error: null,
		lastFrame: 0,
		revision: 0,
	};
	constructor(
		readonly instanceId: string,
		readonly url = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws/session/${instanceId}`,
	) {
		if (!/^[a-f0-9]{16}$/.test(instanceId)) throw new Error("Invalid session id");
	}
	subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	};
	getSnapshot = (): Snapshot => this.#snapshot;
	#publish(update: Partial<Snapshot>): void {
		this.#snapshot = { ...this.#snapshot, ...update, revision: this.#snapshot.revision + 1 };
		for (const listener of this.#listeners) listener();
	}
	connect = (): void => {
		if (this.#stopped || this.#snapshot.phase === "gone") return;
		clearTimeout(this.#retry);
		this.#socket?.close();
		const generation = ++this.#generation;
		this.#decoder = new FrameDecoder();
		this.#events = [];
		this.#publish({ phase: "connecting", dialogs: [] });
		const socket = new WebSocket(this.url);
		this.#socket = socket;
		this.#deadline = window.setTimeout(() => socket.close(), 10_000);
		socket.onmessage = event => {
			if (generation !== this.#generation) return;
			try {
				if (typeof event.data !== "string") throw new Error("Expected RPC text");
				const frame = this.#decoder.push(event.data);
				if (frame) this.#receive(frame);
			} catch (error) {
				this.#publish({ error: error instanceof Error ? error.message : String(error) });
				socket.close(1002, "invalid RPC frame");
			}
		};
		socket.onerror = () => socket.close();
		socket.onclose = () => {
			if (generation !== this.#generation) return;
			clearTimeout(this.#deadline);
			clearInterval(this.#refresh);
			this.#rejectPending();
			if (this.#stopped || this.#snapshot.phase === "gone") return;
			this.#publish({ phase: "offline", dialogs: [], tools: {} });
			this.#retry = window.setTimeout(this.connect, this.#backoff);
			this.#backoff = Math.min(30_000, this.#backoff * 2);
		};
	};
	close(): void {
		this.#stopped = true;
		++this.#generation;
		clearTimeout(this.#retry);
		clearTimeout(this.#deadline);
		clearInterval(this.#refresh);
		this.#socket?.close();
		this.#rejectPending();
		this.#publish({ phase: "closed" });
	}
	#rejectPending(): void {
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(
				new Error("The connection closed. The action may have reached the TUI. Check the transcript before retry."),
			);
		}
		this.#pending.clear();
	}
	request(command: RpcCommand, timeout = 120_000): Promise<RecordValue> {
		const socket = this.#socket;
		if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("The Mac is disconnected"));
		const id = crypto.randomUUID();
		const line = JSON.stringify({ ...command, id });
		if (new TextEncoder().encode(line).byteLength + 1 > 1024 * 1024 || socket.bufferedAmount > 4 * 1024 * 1024)
			return Promise.reject(new Error("The action exceeds the RPC transport limit"));
		const result = Promise.withResolvers<RecordValue>();
		const timer = window.setTimeout(() => {
			this.#pending.delete(id);
			result.reject(new Error("The TUI response timed out. Check its state before retry."));
		}, timeout);
		this.#pending.set(id, { command: command.type, resolve: result.resolve, reject: result.reject, timer });
		try {
			socket.send(line);
		} catch (error) {
			clearTimeout(timer);
			this.#pending.delete(id);
			result.reject(error);
		}
		return result.promise;
	}
	answer(response: RpcExtensionUIResponse): void {
		if (this.#snapshot.phase !== "connected" || this.#socket?.readyState !== WebSocket.OPEN)
			throw new Error("The Mac is disconnected");
		const line = JSON.stringify(response);
		if (new TextEncoder().encode(line).byteLength + 1 > 1024 * 1024 || this.#socket.bufferedAmount > 4 * 1024 * 1024)
			throw new Error("The answer exceeds the RPC transport limit");
		this.#socket.send(line);
		this.#publish({ dialogs: this.#snapshot.dialogs.filter(d => d.id !== response.id) });
	}
	replaceMessages(messages: Message[]): void {
		this.#publish({ messages });
	}
	setThinking(level: string): Promise<RecordValue> {
		const selected = Object.values(ThinkingLevel).find(value => value === level);
		if (!selected) return Promise.reject(new Error("Invalid thinking level"));
		return this.request({ type: "set_thinking_level", level: selected });
	}
	async refresh(): Promise<void> {
		const generation = this.#generation;
		const revision = this.#snapshot.revision;
		const state = await this.request({ type: "get_state" }, 10_000);
		if (generation === this.#generation && revision === this.#snapshot.revision) this.#setState(state);
		const stats = await this.request({ type: "get_session_stats" }, 10_000);
		if (generation !== this.#generation) return;
		this.#publish({ stats });
	}
	#notice(message: string): void {
		this.#publish({ notices: [...this.#snapshot.notices, message] });
	}
	async #rebuild(): Promise<void> {
		const generation = this.#generation;
		const hydration = ++this.#hydration;
		clearInterval(this.#refresh);
		this.#publish({ phase: "rebuilding", tools: {}, dialogs: [], statuses: {}, widgets: {}, agentMessages: {} });
		try {
			await this.request({ type: "negotiate_protocol", protocolVersion: 2 }, 10_000);
			await this.request({ type: "set_event_filter", events: null, messageUpdates: "full" }, 10_000);
			await this.request({ type: "set_ask_dialog", enabled: true }, 10_000);
			await this.request({ type: "set_subagent_subscription", level: "events" }, 10_000);
			const result = await this.request({ type: "get_messages" }, 10_000);
			const state = await this.request({ type: "get_state" }, 10_000);
			if (generation !== this.#generation || hydration !== this.#hydration) return;
			const messages = records(result.messages).map((m, i) => messageOf(m, `snapshot-${i}`));
			const events = this.#events ?? [];
			this.#events = null;
			this.#publish({ messages, phase: "connected", error: null });
			for (const event of events) {
				if (
					["message_start", "message_update", "message_end"].includes(text(event.type)) &&
					messages.some(message => message.key === messageOf(event.message, text(event.messageId)).key)
				)
					continue;
				if (event.type === "session_changed") continue;
				this.#apply(event);
			}
			this.#setState(state);
			this.#backoff = 1000;
			await this.loadCatalog();
			await this.refresh();
			if (generation === this.#generation && hydration === this.#hydration)
				this.#refresh = window.setInterval(() => {
					void this.refresh().catch(error => this.#publish({ error: String(error) }));
				}, 5000);
		} catch (error) {
			if (generation !== this.#generation) return;
			this.#publish({ error: error instanceof Error ? error.message : String(error) });
			this.#socket?.close();
		}
	}
	async loadCatalog(): Promise<void> {
		const generation = this.#generation;
		const [commands, models, levels, agents] = await Promise.all([
			this.request({ type: "get_available_commands" }),
			this.request({ type: "get_available_models" }),
			this.request({ type: "get_available_thinking_levels" }),
			this.request({ type: "get_subagents" }),
		]);
		if (generation === this.#generation)
			this.#publish({
				commands: [...records(commands.commands), ...terminalCommands],
				models: records(models.models),
				levels: strings(levels.levels),
				agents: records(agents.subagents),
			});
	}
	#setState(state: RecordValue): void {
		if (
			typeof state.sessionId !== "string" ||
			typeof state.isStreaming !== "boolean" ||
			!isRecord(state.queuedMessages) ||
			!Array.isArray(state.todoPhases)
		)
			throw new Error("Invalid TUI state");
		strings(state.queuedMessages.steering);
		strings(state.queuedMessages.followUp);
		records(state.todoPhases);
		this.#publish({ state });
	}
	#receive(frame: RecordValue): void {
		this.#snapshot = { ...this.#snapshot, lastFrame: Date.now() };
		if (frame.type === "gateway") {
			if (frame.event === "session_gone") {
				this.#publish({ phase: "gone", dialogs: [], error: "The Mac closed this session. Return to sessions." });
				this.#socket?.close();
			} else if (frame.event === "bridge_offline") {
				this.#publish({ phase: "offline", dialogs: [] });
				this.#socket?.close();
			}
			return;
		}
		if (frame.type === "ready") {
			clearTimeout(this.#deadline);
			void this.#rebuild();
			return;
		}
		if (frame.type === "response") {
			if (typeof frame.id !== "string" || typeof frame.command !== "string" || typeof frame.success !== "boolean")
				throw new Error("Invalid RPC response");
			const pending = this.#pending.get(frame.id);
			if (!pending) return;
			if (frame.command !== pending.command) throw new Error("RPC response command mismatch");
			clearTimeout(pending.timer);
			this.#pending.delete(frame.id);
			if (frame.success) pending.resolve(isRecord(frame.data) ? frame.data : {});
			else pending.reject(new Error(text(frame.error) || "The TUI refused the action"));
			return;
		}
		if (this.#events) {
			this.#events.push(frame);
			return;
		}
		this.#apply(frame);
	}
	#apply(frame: RecordValue): void {
		const snapshot = this.#snapshot;
		if (["message_start", "message_update", "message_end"].includes(text(frame.type))) {
			const message = messageOf(frame.message, text(frame.messageId));
			const index = snapshot.messages.findIndex(m => m.key === message.key);
			const messages = [...snapshot.messages];
			if (index < 0) messages.push(message);
			else messages[index] = message;
			this.#publish({ messages });
		} else if (frame.type === "queue_update") {
			const queuedMessages = { steering: strings(frame.steering), followUp: strings(frame.followUp) };
			this.#publish({
				state: {
					...snapshot.state,
					queuedMessages,
					queuedMessageCount: queuedMessages.steering.length + queuedMessages.followUp.length,
				},
			});
		} else if (frame.type === "agent_start") this.#publish({ state: { ...snapshot.state, isStreaming: true } });
		else if (frame.type === "agent_end" || frame.type === "session_settled") {
			this.#publish({ state: { ...snapshot.state, isStreaming: false } });
			void this.refresh().catch(error => this.#publish({ error: String(error) }));
		} else if (frame.type === "session_changed") {
			this.#events = [];
			void this.#rebuild();
		} else if (frame.type === "available_commands_update")
			this.#publish({ commands: [...records(frame.commands), ...terminalCommands] });
		else if (frame.type === "extension_ui_request") this.#ui(frame);
		else if (text(frame.type).startsWith("subagent_")) {
			if (isRecord(frame.payload)) {
				const payload = frame.payload;
				const progress = isRecord(payload.progress) ? payload.progress : {};
				const id = text(payload.subagentId) || text(payload.id) || text(progress.id);
				const previous = snapshot.agents.find(agent => agent.id === id);
				if (id)
					this.#publish({
						agents: [
							...snapshot.agents.filter(agent => agent.id !== id),
							{
								...previous,
								...payload,
								id,
								status:
									payload.status === "started"
										? "running"
										: (payload.status ?? progress.status ?? previous?.status),
								updatedAt: snapshot.revision,
							},
						],
					});
				if (
					id &&
					isRecord(payload.event) &&
					["message_start", "message_update", "message_end"].includes(text(payload.event.type))
				) {
					const message = messageOf(payload.event.message, text(payload.event.messageId));
					const messages = [...(snapshot.agentMessages[id] ?? [])];
					const index = messages.findIndex(previous => previous.key === message.key);
					if (index < 0) messages.push(message);
					else messages[index] = message;
					this.#publish({ agentMessages: { ...snapshot.agentMessages, [id]: messages } });
				}
			}
		} else if (text(frame.type).startsWith("tool_execution_")) {
			const id = text(frame.toolCallId);
			if (id) this.#publish({ tools: { ...snapshot.tools, [id]: { ...snapshot.tools[id], ...frame } } });
		} else if (frame.type === "notice" || frame.type === "rpc_frame_error")
			this.#notice(text(frame.message) || text(frame.error));
		else if (frame.type === "prompt_result" && frame.status !== "completed")
			this.#notice(
				frame.status === "aborted"
					? "Stopped by you"
					: isRecord(frame.error)
						? text(frame.error.message)
						: "The turn failed",
			);
		else if (
			[
				"auto_compaction_start",
				"auto_compaction_end",
				"auto_retry_start",
				"auto_retry_end",
				"cache_warming_start",
				"cache_warming_end",
				"retry_fallback_applied",
			].includes(text(frame.type))
		)
			this.#notice(`${text(frame.type).replaceAll("_", " ")}${frame.errorMessage ? `: ${frame.errorMessage}` : ""}`);
		else if (
			["model_changed", "thinking_level_changed", "goal_updated", "todo_auto_clear", "todo_reminder"].includes(
				text(frame.type),
			)
		)
			void this.refresh().catch(error => this.#publish({ error: String(error) }));
	}
	#ui(frame: RecordValue): void {
		const snapshot = this.#snapshot;
		if (frame.method === "cancel")
			this.#publish({ dialogs: snapshot.dialogs.filter(dialog => dialog.id !== frame.targetId) });
		else if (frame.method === "notify") this.#notice(text(frame.message));
		else if (frame.method === "setStatus") {
			const statuses = { ...snapshot.statuses };
			const key = text(frame.statusKey);
			if (typeof frame.statusText === "string") statuses[key] = frame.statusText;
			else delete statuses[key];
			this.#publish({ statuses });
		} else if (frame.method === "setWidget") {
			const widgets = { ...snapshot.widgets };
			const key = text(frame.widgetKey);
			if (frame.widgetLines) widgets[key] = strings(frame.widgetLines);
			else delete widgets[key];
			this.#publish({ widgets });
		} else if (["ask", "select", "confirm", "input", "editor"].includes(text(frame.method))) {
			if (typeof frame.id !== "string") throw new Error("Invalid dialog id");
			if (!snapshot.dialogs.some(dialog => dialog.id === frame.id))
				this.#publish({ dialogs: [...snapshot.dialogs, frame] });
		} else if (frame.method === "setTitle") document.title = text(frame.title);
		else if (frame.method === "set_editor_text")
			this.#publish({ editorText: { text: text(frame.text), version: snapshot.revision } });
		else if (frame.method === "open_url") this.#notice("A terminal-only login request is open on the Mac.");
	}
}

export const TERMINAL_COMMANDS: string[] = terminalCommands.map(command => command.name);
