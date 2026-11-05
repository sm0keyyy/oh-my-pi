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
	commandOutputs: string[];
	stats: RecordValue;
	error: string | null;
	lastFrame: number;
	revision: number;
	editorText?: { text: string; version: number };
	history?: { olderCursor?: string; newer: boolean; loading: boolean };
}
interface Pending {
	command: string;
	resolve(value: RecordValue): void;
	reject(error: Error): void;
	timer?: number;
	hydration?: number;
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
	#source?: EventSource;
	#client = crypto.randomUUID();
	#lastId = "";
	#streamReady = false;
	#sequence = 0;
	#outbox: Array<{ sequence: number; line: string; bytes: number; sent: boolean }> = [];
	#outboxBytes = 0;
	#posting = false;
	#postRetry?: number;
	#gapTimer?: number;
	#hasState = false;
	#bridgeOffline = false;
	#listeners = new Set<() => void>();
	#pending = new Map<string, Pending>();
	#decoder = new FrameDecoder();
	#retry?: number;
	#refresh?: number;
	#stopped = false;
	#generation = 0;
	#hydration = 0;
	#events: RecordValue[] | null = null;
	#watchdog?: number;
	#lastActivity = 0;
	#needsResync = false;
	#historyRequest = 0;
	#loadingHistory = false;
	#pageEvents: RecordValue[] | null = null;
	#backwardPaging = false;
	#readingHistory = false;
	#resume = (event: Event): void => {
		if (typeof document !== "undefined" && document.hidden) return;
		if (
			event.type === "online" ||
			("persisted" in event && event.persisted === true) ||
			!this.#streamReady ||
			Date.now() - this.#lastActivity > 20_000
		)
			this.connect();
	};
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
		commandOutputs: [],
		error: null,
		lastFrame: 0,
		revision: 0,
	};
	constructor(
		readonly instanceId: string,
		readonly url = `${location.origin}/events/session/${instanceId}`,
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
	#gap(): void {
		if (this.#gapTimer !== undefined || this.#stopped) return;
		this.#gapTimer = window.setTimeout(() => {
			this.#publish({ phase: "offline" });
		}, 5000);
	}
	#recovered(bridgeReady = false): void {
		if (bridgeReady) this.#bridgeOffline = false;
		if (this.#bridgeOffline) return;
		clearTimeout(this.#gapTimer);
		this.#gapTimer = undefined;
		if (this.#hasState && (this.#snapshot.phase === "offline" || this.#snapshot.error))
			this.#publish({ phase: "connected", error: null });
		void this.#sendQueued();
	}
	#retryStream(resync = false): void {
		this.#needsResync ||= resync;
		this.#streamReady = false;
		++this.#generation;
		this.#source?.close();
		this.#gap();
		clearTimeout(this.#retry);
		this.#retry = window.setTimeout(this.connect, 1000);
	}
	connect = (): void => {
		if (this.#stopped || this.#snapshot.phase === "gone") return;
		if (this.#watchdog === undefined) {
			window.addEventListener("online", this.#resume);
			window.addEventListener("pageshow", this.#resume);
			if (typeof document !== "undefined") document.addEventListener("visibilitychange", this.#resume);
			this.#watchdog = window.setInterval(() => {
				if (typeof document !== "undefined" && document.hidden) return;
				if (Date.now() - this.#lastActivity > 45_000) this.connect();
			}, 5000);
		}
		clearTimeout(this.#retry);
		this.#source?.close();
		this.#streamReady = false;
		const generation = ++this.#generation;
		this.#lastActivity = Date.now();
		if (!this.#lastId) this.#events = [];
		const target = new URL(this.url);
		target.searchParams.set("client", this.#client);
		if (this.#lastId) target.searchParams.set("lastEventId", this.#lastId);
		if (this.#needsResync) target.searchParams.set("resync", "1");
		const source = new EventSource(target);
		this.#source = source;
		this.#gap();
		source.onopen = () => {
			if (generation === this.#generation) this.#lastActivity = Date.now();
		};
		source.addEventListener("heartbeat", () => {
			if (generation === this.#generation) this.#lastActivity = Date.now();
		});
		source.onmessage = event => {
			if (generation !== this.#generation) return;
			this.#lastActivity = Date.now();
			const previousId = this.#lastId;
			try {
				const value: unknown = JSON.parse(event.data);
				if (!isRecord(value)) throw new Error("Invalid stream event");
				if (event.lastEventId === this.#lastId) return;
				if (!event.lastEventId) throw new Error("Missing stream sequence");
				const [epoch, sequence, extra] = event.lastEventId.split(":");
				const [previousEpoch, previousSequence] = this.#lastId.split(":");
				if (
					!epoch ||
					extra !== undefined ||
					!/^\d+$/.test(sequence ?? "") ||
					!Number.isSafeInteger(Number(sequence)) ||
					Number(sequence) < 1
				)
					throw new Error("Invalid stream sequence");
				if (previousEpoch && epoch !== previousEpoch && value.event !== "resync")
					throw new Error("Stream epoch changed without resync");
				if (epoch === previousEpoch && Number(sequence) <= Number(previousSequence)) return;
				if (
					epoch === previousEpoch &&
					Number(sequence) !== Number(previousSequence) + 1 &&
					value.event !== "resync"
				)
					throw new Error("Stream sequence gap");
				if (value.type !== "cursor") {
					const frame = value.type === "gateway" ? value : this.#decoder.push(event.data);
					this.#lastId = event.lastEventId;
					if (frame) this.#receive(frame);
				}
				this.#lastId = event.lastEventId;
			} catch {
				this.#lastId = previousId;
				this.#retryStream(true);
			}
		};
		source.onerror = () => {
			if (generation !== this.#generation || this.#stopped) return;
			this.#streamReady = false;
			this.#gap();
			if (source.readyState === EventSource.CLOSED) this.#retryStream();
		};
	};
	#enqueue(line: string): void {
		const bytes = new TextEncoder().encode(line).byteLength;
		if (bytes + 1 > 1024 * 1024 || this.#outboxBytes + bytes > 4 * 1024 * 1024)
			throw new Error("The action exceeds the RPC transport limit");
		this.#outbox.push({ sequence: ++this.#sequence, line, bytes, sent: false });
		this.#outboxBytes += bytes;
		void this.#sendQueued();
	}
	async #sendQueued(): Promise<void> {
		if (this.#posting || this.#stopped || !this.#streamReady || this.#source?.readyState !== EventSource.OPEN) return;
		this.#posting = true;
		try {
			while (this.#outbox.length && !this.#stopped && this.#streamReady) {
				const item = this.#outbox[0]!;
				const target = new URL(this.url);
				target.pathname = target.pathname.replace("/events/session/", "/api/session/");
				item.sent = true;
				const response = await fetch(target, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						"idempotency-key": `${this.#client}:${item.sequence}`,
						"x-omp-epoch": this.#lastId.split(":")[0]!,
					},
					body: JSON.stringify({ client: this.#client, sequence: item.sequence, line: item.line }),
					signal: AbortSignal.timeout(10_000),
				});
				if (!response.ok) throw new Error(`Command POST failed: ${response.status}`);
				const body: unknown = await response.json();
				if (!isRecord(body) || !Number.isSafeInteger(body.ack) || Number(body.ack) < item.sequence)
					throw new Error("Invalid command acknowledgement");
				while (this.#outbox[0] && this.#outbox[0].sequence <= Number(body.ack))
					this.#outboxBytes -= this.#outbox.shift()!.bytes;
				this.#recovered();
			}
		} catch {
			if (!this.#stopped) {
				this.#gap();
				this.#postRetry = window.setTimeout(() => void this.#sendQueued(), 250);
			}
		} finally {
			this.#posting = false;
		}
	}
	close(): void {
		this.#stopped = true;
		++this.#generation;
		clearTimeout(this.#retry);
		clearTimeout(this.#gapTimer);
		clearTimeout(this.#postRetry);
		clearInterval(this.#refresh);
		clearInterval(this.#watchdog);
		window.removeEventListener("online", this.#resume);
		window.removeEventListener("pageshow", this.#resume);
		if (typeof document !== "undefined") document.removeEventListener("visibilitychange", this.#resume);
		this.#source?.close();
		if (this.#source) {
			const target = new URL(this.url);
			target.pathname = target.pathname.replace("/events/session/", "/api/session/");
			target.searchParams.set("client", this.#client);
			void fetch(target, { method: "DELETE", keepalive: true }).catch(() => {
				// Page teardown is best effort; the session owner also releases clients at session exit.
			});
		}
		this.#rejectPending();
		this.#publish({ phase: "closed" });
	}
	#rejectPending(retained?: Set<string>): void {
		for (const [id, pending] of this.#pending) {
			if (retained?.has(id)) continue;
			clearTimeout(pending.timer);
			pending.reject(
				new Error("The connection closed. The action may have reached the TUI. Check the transcript before retry."),
			);
			this.#pending.delete(id);
		}
	}
	request(command: RpcCommand, timeout = 120_000): Promise<RecordValue> {
		return this.#request(command, timeout);
	}
	#request(command: RpcCommand, timeout: number, hydration?: number): Promise<RecordValue> {
		if (this.#stopped || this.#snapshot.phase === "gone") return Promise.reject(new Error("The session is closed"));
		const id = crypto.randomUUID();
		const line = JSON.stringify({ ...command, id });
		const result = Promise.withResolvers<RecordValue>();
		const timer =
			timeout > 0
				? window.setTimeout(() => {
						this.#pending.delete(id);
						result.reject(new Error("The TUI response timed out. Check its state before retry."));
					}, timeout)
				: undefined;
		this.#pending.set(id, {
			command: command.type,
			resolve: result.resolve,
			reject: result.reject,
			timer,
			hydration,
		});
		try {
			this.#enqueue(line);
		} catch (error) {
			clearTimeout(timer);
			this.#pending.delete(id);
			result.reject(error);
		}
		return result.promise;
	}
	answer(response: RpcExtensionUIResponse): void {
		if (this.#snapshot.phase !== "connected") throw new Error("The Mac is disconnected");
		const dialog = this.#snapshot.dialogs.find(dialog => dialog.id === response.id);
		if (!dialog) throw new Error("This dialog is no longer open");
		if (dialog.method === "ask" && !("cancelled" in response)) {
			const questions = records(dialog.questions);
			if (
				!("answers" in response) ||
				!Array.isArray(response.answers) ||
				response.answers.length !== questions.length
			)
				throw new Error("Answer every question in this dialog");
			for (const [index, question] of questions.entries()) {
				const answer = response.answers[index];
				if (!answer || answer.id !== question.id) throw new Error("The answer does not match this question");
				const selected = strings(answer.selectedOptions);
				const labels = records(question.options).map(option => text(option.label));
				if (selected.some(label => !labels.includes(label)) || new Set(selected).size !== selected.length)
					throw new Error("Choose each listed option at most once");
				if (answer.customInput !== undefined && typeof answer.customInput !== "string")
					throw new Error("The custom answer must be text");
				if (!question.multi && (selected.length > 1 || (selected.length > 0 && answer.customInput?.trim())))
					throw new Error("Choose one option or a custom answer, not both");
			}
		}
		const line = JSON.stringify(response);
		this.#enqueue(line);
		this.#publish({ dialogs: this.#snapshot.dialogs.filter(d => d.id !== response.id) });
	}
	clearCommandOutputs(): void {
		this.#publish({ commandOutputs: [] });
	}
	async loadLatest(): Promise<void> {
		if (this.#loadingHistory) return;
		await this.#loadPage();
	}
	async loadOlder(): Promise<void> {
		const cursor = this.#snapshot.history?.olderCursor;
		if (!cursor || this.#loadingHistory) return;
		await this.#loadPage(cursor);
	}
	async #loadPage(cursor?: string): Promise<void> {
		this.#loadingHistory = true;
		const request = ++this.#historyRequest;
		const hydration = this.#hydration;
		if (!cursor) this.#pageEvents = [];
		this.#publish({
			history: { ...this.#snapshot.history, newer: this.#snapshot.history?.newer ?? false, loading: true },
		});
		try {
			const result = await this.#request(
				this.#backwardPaging
					? { type: "get_messages_page", backward: true, limit: 50, cursor }
					: { type: "get_messages" },
				0,
			);
			if (
				request !== this.#historyRequest ||
				hydration !== this.#hydration ||
				this.#stopped ||
				(cursor !== undefined && this.#snapshot.history?.olderCursor !== cursor)
			)
				return;
			const page = this.#page(result);
			this.#readingHistory = cursor !== undefined;
			this.#loadingHistory = false;
			const keys = new Set(page.messages.map(message => message.key));
			const messages = cursor
				? [...page.messages, ...this.#snapshot.messages.filter(message => !keys.has(message.key))]
				: page.messages;
			this.#publish({
				messages: this.#backwardPaging ? messages.slice(0, 150) : messages,
				history: {
					olderCursor: page.olderCursor,
					newer: Boolean(cursor && (this.#snapshot.history?.newer || messages.length > 150)),
					loading: false,
				},
				error: null,
			});
			if (!cursor) {
				const events = this.#pageEvents ?? [];
				this.#pageEvents = null;
				for (const event of events) this.#apply(event);
			}
		} catch (error) {
			if (request === this.#historyRequest && hydration === this.#hydration && !this.#stopped)
				this.#publish({
					error: String(error),
					history: { ...this.#snapshot.history, newer: this.#snapshot.history?.newer ?? false, loading: false },
				});
		} finally {
			if (request === this.#historyRequest) this.#loadingHistory = false;
			if (request === this.#historyRequest) this.#pageEvents = null;
		}
	}
	#page(result: RecordValue): { messages: Message[]; olderCursor?: string } {
		if (!this.#backwardPaging)
			return { messages: records(result.messages).map((message, index) => messageOf(message, `snapshot-${index}`)) };
		if (
			!Number.isSafeInteger(result.totalMessages) ||
			Number(result.totalMessages) < 0 ||
			(result.nextCursor !== undefined && typeof result.nextCursor !== "string")
		)
			throw new Error("Invalid message page from the TUI");
		return {
			messages: records(result.messages).map((message, index) => messageOf(message, `snapshot-${index}`)),
			olderCursor: typeof result.nextCursor === "string" ? result.nextCursor : undefined,
		};
	}
	setThinking(level: string): Promise<RecordValue> {
		const selected = Object.values(ThinkingLevel).find(value => value === level);
		if (!selected) return Promise.reject(new Error("Invalid thinking level"));
		return this.request({ type: "set_thinking_level", level: selected });
	}
	async refresh(): Promise<void> {
		const generation = this.#generation;
		const hydration = this.#hydration;
		const revision = this.#snapshot.revision;
		const state = await this.request({ type: "get_state" }, 10_000);
		if (generation !== this.#generation || hydration !== this.#hydration) return;
		if (revision === this.#snapshot.revision) this.#setState(state);
		const stats = await this.request({ type: "get_session_stats" }, 10_000);
		if (generation !== this.#generation || hydration !== this.#hydration) return;
		this.#publish({ stats });
	}
	#notice(message: string): void {
		this.#publish({ notices: [...this.#snapshot.notices, message] });
	}
	retry = (): void => {
		if (this.#snapshot.error && this.#streamReady) void this.#rebuild();
		else this.connect();
	};
	async #rebuild(): Promise<void> {
		const hydration = ++this.#hydration;
		++this.#historyRequest;
		this.#loadingHistory = false;
		this.#pageEvents = null;
		this.#events ??= [];
		clearInterval(this.#refresh);
		this.#publish({ error: null, ...(!this.#hasState ? { phase: "rebuilding" as const } : {}) });
		try {
			await this.#request({ type: "negotiate_protocol", protocolVersion: 2 }, 0);
			await this.#request({ type: "set_event_filter", events: null, messageUpdates: "full" }, 0);
			await this.#request({ type: "set_ask_dialog", enabled: true }, 0);
			await this.#request({ type: "set_subagent_subscription", level: "events" }, 0);
			if (this.#stopped || hydration !== this.#hydration) return;
			const result = await this.#request(
				this.#backwardPaging
					? { type: "get_messages_page", backward: true, limit: 50 }
					: { type: "get_messages" },
				0,
				hydration,
			);
			if (this.#stopped || hydration !== this.#hydration) return;
			const state = await this.#request({ type: "get_state" }, 0, hydration);
			if (this.#stopped || hydration !== this.#hydration) return;
			const page = this.#page(result);
			this.#readingHistory = false;
			const events = this.#events ?? [];
			this.#events = null;
			this.#setState(state);
			this.#publish({
				messages: page.messages,
				history: { olderCursor: page.olderCursor, newer: false, loading: false },
				tools: {},
				dialogs: [],
				agentMessages: {},
			});
			for (const event of events) this.#apply(event);
			this.#publish({ phase: "connected", error: null });
			this.#hasState = true;
			this.#recovered();
			this.#refresh = window.setInterval(() => {
				void this.refresh().catch(error => this.#publish({ error: String(error) }));
			}, 5000);
			await this.loadCatalog();
			await this.refresh();
		} catch (error) {
			if (this.#stopped || hydration !== this.#hydration) return;
			this.#events = null;
			this.#publish({ error: String(error), phase: this.#hasState ? "connected" : "offline" });
		}
	}
	async loadCatalog(): Promise<void> {
		const hydration = this.#hydration;
		const [commands, models, levels, agents] = await Promise.all([
			this.request({ type: "get_available_commands" }),
			this.request({ type: "get_available_models" }),
			this.request({ type: "get_available_thinking_levels" }),
			this.request({ type: "get_subagents" }),
		]);
		if (!this.#stopped && hydration === this.#hydration)
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
				this.#source?.close();
			} else if (["bridge_reconnecting", "bridge_offline", "session_unavailable"].includes(text(frame.event))) {
				this.#bridgeOffline = true;
				this.#gap();
			} else if (frame.event === "bridge_resumed" || frame.event === "resumed") {
				this.#streamReady = true;
				this.#recovered(frame.event === "bridge_resumed");
			} else if (frame.event === "resync") {
				this.#streamReady = false;
				this.#needsResync = false;
				this.#decoder = new FrameDecoder();
				this.#events = [];
				++this.#hydration;
				const unsent = this.#outbox.filter(item => !item.sent);
				const retained = new Set<string>();
				for (const item of unsent) {
					const command: unknown = JSON.parse(item.line);
					if (isRecord(command) && typeof command.id === "string") retained.add(command.id);
				}
				if (frame.resetCommands === true) {
					// A new gateway cannot prove whether sent mutations ran; never replay those.
					this.#outbox = unsent;
					this.#sequence = 0;
					this.#outboxBytes = 0;
					for (const item of unsent) {
						item.sequence = ++this.#sequence;
						this.#outboxBytes += item.bytes;
					}
				}
				this.#rejectPending(retained);
			}
			return;
		}
		if (frame.type === "ready") {
			this.#backwardPaging = frame.messagePaging === "backward";
			this.#streamReady = true;
			this.#recovered(true);
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
			if (
				frame.success &&
				(pending.command === "get_messages_page" || pending.command === "get_messages") &&
				this.#pageEvents
			)
				this.#pageEvents = [];
			if (frame.success && this.#events && pending.hydration === this.#hydration) {
				// The synchronous RPC response separates the snapshot from later stream events.
				const replaced =
					pending.command === "get_messages_page" || pending.command === "get_messages"
						? ["message_start", "message_update", "message_end"]
						: ["agent_start", "agent_end", "session_settled", "queue_update"];
				this.#events = this.#events.filter(event => !replaced.includes(text(event.type)));
			}
			if (frame.success) pending.resolve(isRecord(frame.data) ? frame.data : {});
			else pending.reject(new Error(text(frame.error) || "The TUI refused the action"));
			return;
		}
		if (frame.type === "session_changed") {
			this.#events = [];
			this.#publish({ commandOutputs: [] });
			void this.#rebuild();
			return;
		}
		if (
			frame.type === "extension_ui_request" &&
			["snapshot", "setStatus", "setWidget"].includes(text(frame.method))
		) {
			this.#ui(frame);
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
			if (this.#pageEvents) {
				const previous = this.#pageEvents.findIndex(
					event => messageOf(event.message, text(event.messageId)).key === message.key,
				);
				if (previous < 0) this.#pageEvents.push(frame);
				else this.#pageEvents[previous] = frame;
			}
			if (snapshot.history?.newer) return;
			const index = snapshot.messages.findIndex(m => m.key === message.key);
			if (index < 0 && (this.#readingHistory || this.#loadingHistory)) {
				this.#publish({
					history: { ...snapshot.history, newer: true, loading: snapshot.history?.loading ?? false },
				});
				return;
			}
			const messages = [...snapshot.messages];
			if (index < 0) messages.push(message);
			else messages[index] = message;
			this.#publish({ messages: this.#backwardPaging ? messages.slice(-150) : messages });
			if (this.#backwardPaging && messages.length > 150) void this.loadLatest();
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
		} else if (frame.type === "available_commands_update")
			this.#publish({ commands: [...records(frame.commands), ...terminalCommands] });
		else if (frame.type === "extension_ui_request") this.#ui(frame);
		else if (frame.type === "command_output") {
			if (typeof frame.text !== "string") throw new Error("Invalid command output");
			this.#publish({ commandOutputs: [...snapshot.commandOutputs, frame.text] });
		} else if (text(frame.type).startsWith("subagent_")) {
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
		if (frame.method === "snapshot") {
			if (!isRecord(frame.statuses) || !isRecord(frame.widgets)) throw new Error("Invalid host UI snapshot");
			const statuses: Record<string, string> = {};
			const widgets: Record<string, string[]> = {};
			for (const [key, value] of Object.entries(frame.statuses)) {
				if (typeof value !== "string") throw new Error("Invalid host status text");
				statuses[key] = value;
			}
			for (const [key, value] of Object.entries(frame.widgets)) {
				if (!isRecord(value) || !["aboveEditor", "belowEditor"].includes(text(value.placement)))
					throw new Error("Invalid host widget");
				widgets[key] = strings(value.lines);
			}
			this.#publish({ statuses, widgets });
		} else if (frame.method === "cancel")
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
