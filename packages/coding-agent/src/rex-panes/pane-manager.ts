import { TASK_SUBAGENT_LIFECYCLE_CHANNEL } from "@oh-my-pi/pi-tui/overlays/session-observer-registry";
import { isRecord, logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import type { ExtensionUIContext } from "../extensibility/extensions/types";
import type { AgentRef, AgentRegistry } from "../registry/agent-registry";
import type { AgentSession } from "../session/agent-session";
import { TASK_SUBAGENT_EVENT_CHANNEL } from "../task/types";
import type { EventBus } from "../utils/event-bus";
import type { RexLocation } from "./component-pane";
import { removePaneRecord, writePaneRecord } from "./pane-records";
import type { RexCli } from "./rex-cli";
import { cfgRexSubagentPanes } from "./settings";
import { PaneReopenGate, registerPaneSupervisor, type ReopenOutcome } from "./supervise";

export const FINISHED_PANES_KEPT = 5;
export type PaneTab = "live" | "thread";

export interface OpenPane {
	readonly ui: ExtensionUIContext | undefined;
	readonly closed: Promise<void>;
	finish?(): Promise<void>;
	revive?(session: AgentSession): Promise<void>;
	setTab?(tab: PaneTab): void;
	dispose(): Promise<void>;
}

export interface PaneManagerDeps {
	rex: RexCli;
	registry: Pick<AgentRegistry, "get" | "onChange">;
	subagentEventBus: EventBus;
	socketPath: string;
	relayPath: string;
	newToken(): string;
	prepareToken(token: string): Promise<string>;
	openPane(agentId: string, session: AgentSession | null, token: string): Promise<OpenPane>;
	onPaneOpened(agentId: string): void;
}

export interface PaneManager {
	paneUi(agentId: string): ExtensionUIContext | undefined;
	location(agentId: string): RexLocation | undefined;
	reveal(agentId: string, options?: { tab?: PaneTab }): Promise<boolean>;
	dispose(): Promise<void>;
}

interface ActivePane {
	session: AgentSession | null;
	blockId: string;
	pane: OpenPane;
}

interface Member {
	id: string;
	group: Group;
	slot: number;
	session: AgentSession | null;
	active?: ActivePane;
	failed: boolean;
	queued: boolean;
	everOpened: boolean;
	requested: boolean;
	finished: boolean;
	tab: PaneTab;
	lastBlockId?: string;
	previousBlockId?: string;
	gate: PaneReopenGate;
}

interface Group {
	first: string;
	members: Set<Member>;
	// Failed kills retain identities even after a new group session opens.
	blocks: Map<string, Set<string>>;
	nextSlot: number;
	sessionId?: string;
	label?: string;
	tail: Promise<void>;
}

export function rexPanesEligible(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, settings: Settings): boolean {
	return env.TERM_PROGRAM === "rex" && platform === "darwin" && cfgRexSubagentPanes.get(settings);
}

export function startPaneManager(deps: PaneManagerDeps): PaneManager {
	return new Manager(deps);
}

class Manager implements PaneManager {
	readonly #groups = new Map<string, Group>();
	readonly #members = new Map<string, Member>();
	readonly #unsubscribers: Array<() => void>;
	readonly #finished: Member[] = [];
	#disposed = false;
	#warned = false;
	#disposePromise?: Promise<void>;

	constructor(readonly deps: PaneManagerDeps) {
		this.#unsubscribers = [
			registerPaneSupervisor(this),
			deps.subagentEventBus.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, data => {
				if (!isRecord(data) || typeof data.id !== "string") return;
				if (data.status === "started") {
					this.#started(data.id, typeof data.parentToolCallId === "string" ? data.parentToolCallId : undefined);
				} else {
					this.#changed(data.id);
				}
			}),
			deps.subagentEventBus.on(TASK_SUBAGENT_EVENT_CHANNEL, data => {
				if (isRecord(data) && typeof data.id === "string") this.#changed(data.id);
			}),
			deps.registry.onChange(event => {
				this.#changed(event.ref.id);
				if (event.type !== "removed") return;
				const member = this.#members.get(event.ref.id);
				if (!member) return;
				this.#queue(member.group, async () => {
					if (this.deps.registry.get(member.id)) return;
					member.gate.clear();
					member.group.members.delete(member);
					this.#members.delete(member.id);
					await this.#killEmpty(member.group);
					if (member.group.members.size === 0 && !member.group.sessionId && member.group.blocks.size === 0) {
						for (const [key, group] of this.#groups) if (group === member.group) this.#groups.delete(key);
					}
				});
			}),
		];
	}

	paneUi(agentId: string): ExtensionUIContext | undefined {
		const member = this.#members.get(agentId);
		return member?.finished ? undefined : member?.active?.pane.ui;
	}

	location(agentId: string): RexLocation | undefined {
		const member = this.#members.get(agentId);
		const sessionId = member?.group.sessionId;
		return sessionId && member?.active ? { sessionId, blockId: member.active.blockId } : undefined;
	}

	async reveal(agentId: string, options?: { tab?: PaneTab }): Promise<boolean> {
		const ref = this.deps.registry.get(agentId);
		if (this.#disposed || ref?.kind !== "sub") return false;
		if (!this.#members.has(agentId)) this.#started(agentId, undefined, true);
		const member = this.#members.get(agentId);
		if (!member) return false;
		member.failed = false;
		member.tab = options?.tab ?? (this.#live(ref) ? member.tab : "thread");
		let revealed = false;
		this.#queue(member.group, async () => {
			if (this.#disposed || !this.deps.registry.get(agentId)) return;
			if (!member.active) await this.#open(member, this.#live(this.deps.registry.get(agentId)));
			member.active?.pane.setTab?.(member.tab);
			const location = this.location(agentId);
			if (!location) return;
			await this.deps.rex.focusBlock(location.sessionId, location.blockId);
			revealed = true;
		});
		await member.group.tail;
		return revealed;
	}

	markCrashed(blockId: string): boolean {
		const member = this.#memberForBlock(blockId);
		if (!member) return false;
		member.gate.markCrashed();
		return true;
	}

	async reopen(blockId: string): Promise<ReopenOutcome> {
		const member = this.#memberForBlock(blockId);
		if (!member) return { ok: false, reason: "unknown-block" };
		let outcome: ReopenOutcome = { ok: false, reason: "agent-gone" };
		this.#queue(member.group, async () => {
			const session = this.#live(this.deps.registry.get(member.id));
			if (this.#disposed || !session) {
				member.gate.clear();
				this.#queue(member.group, () => this.#killEmpty(member.group));
				return;
			}
			if (member.active) {
				outcome = { ok: false, reason: "already-open" };
				return;
			}
			member.gate.clear();
			member.failed = false;
			member.session = session;
			member.requested = false;
			await this.#open(member, session);
			if (member.active) outcome = { ok: true };
		});
		await member.group.tail;
		return outcome;
	}

	#memberForBlock(blockId: string): Member | undefined {
		for (const member of this.#members.values())
			if (member.lastBlockId === blockId || member.previousBlockId === blockId) return member;
		return undefined;
	}

	#warn(cause: unknown): void {
		if (this.#warned) return;
		this.#warned = true;
		logger.warn("rex-panes: pane operation failed; main TUI remains available", {
			error: cause instanceof Error ? cause.message : String(cause),
		});
	}

	#queue(group: Group, work: () => Promise<void>): void {
		group.tail = group.tail.then(work).catch(error => this.#warn(error));
	}

	#live(ref: AgentRef | undefined): AgentSession | null {
		return ref?.kind === "sub" && ref.status !== "parked" && ref.status !== "aborted" ? ref.session : null;
	}

	#started(id: string, parentToolCallId: string | undefined, reveal = false): void {
		if (this.#disposed) return;
		const ref = this.deps.registry.get(id);
		if (ref?.kind !== "sub" || (!reveal && !this.#live(ref))) return;
		let member = this.#members.get(id);
		if (!member) {
			let group: Group | undefined;
			const visited = new Set<string>([id]);
			let parentId = ref?.parentId;
			while (parentId && !visited.has(parentId)) {
				visited.add(parentId);
				group = this.#members.get(parentId)?.group;
				if (group) break;
				parentId = this.deps.registry.get(parentId)?.parentId;
			}
			const key = parentToolCallId ?? id;
			if (!group) {
				group = this.#groups.get(key);
				if (!group) {
					group = { first: id, members: new Set(), blocks: new Map(), nextSlot: 0, tail: Promise.resolve() };
					this.#groups.set(key, group);
				}
			}
			member = {
				id,
				group,
				slot: group.nextSlot++,
				session: null,
				failed: false,
				queued: false,
				everOpened: false,
				requested: false,
				finished: false,
				tab: "live",
				gate: new PaneReopenGate(() => {
					const current = this.#members.get(id);
					if (!current || this.#disposed) return;
					if (current.requested) this.#changed(id);
					this.#queue(current.group, () => this.#killEmpty(current.group));
				}),
			};
			group.members.add(member);
			this.#members.set(id, member);
		}
		member.failed = false;
		this.#changed(id);
	}

	#changed(id: string): void {
		if (this.#disposed) return;
		const member = this.#members.get(id);
		if (!member) return;
		const ref = this.deps.registry.get(id);
		const session = this.#live(ref);
		if (member.session !== session) member.failed = false;
		member.session = session;
		member.requested = session !== null;
		if (member.queued) return;
		member.queued = true;
		this.#queue(member.group, async () => {
			try {
				if (this.#disposed) return;
				const current = this.deps.registry.get(id);
				if (!current) {
					await this.#close(member);
					return;
				}
				if (member.failed) return;
				const desired = this.#live(current);
				if (!desired) {
					if ((current.status === "parked" || current.status === "aborted") && member.active)
						await this.#finish(member);
					return;
				}
				if (member.active) {
					const active = member.active;
					if (active.session !== desired) {
						this.#forgetFinished(member);
						await active.pane.revive?.(desired);
						if (member.active !== active) return;
						active.session = desired;
						this.deps.onPaneOpened(id);
					}
					return;
				}
				if (!member.requested || member.gate.held) return;
				member.requested = false;
				await this.#open(member, desired);
			} catch (error) {
				member.failed = true;
				throw error;
			} finally {
				member.queued = false;
				const latest = this.deps.registry.get(id);
				if (
					!member.failed &&
					member.active &&
					((this.#live(latest) && member.active.session !== this.#live(latest)) ||
						((latest?.status === "parked" || latest?.status === "aborted") && !member.finished))
				)
					this.#changed(id);
			}
		});
	}

	#forgetFinished(member: Member): void {
		member.finished = false;
		const index = this.#finished.indexOf(member);
		if (index !== -1) this.#finished.splice(index, 1);
	}

	async #finish(member: Member): Promise<void> {
		const active = member.active;
		if (member.finished || !active) return;
		await active.pane.finish?.();
		active.session = null;
		if (member.active !== active) return;
		member.session = null;
		member.finished = true;
		this.#finished.push(member);
		while (this.#finished.length > FINISHED_PANES_KEPT) {
			const oldest = this.#finished.shift();
			const evicted = oldest?.active;
			if (!oldest || !evicted) continue;
			if (oldest.group === member.group) await this.#close(oldest);
			else
				this.#queue(oldest.group, async () => {
					if (oldest.finished && oldest.active === evicted) await this.#close(oldest);
				});
		}
	}

	#removeRecord(group: Group, sessionId: string, blockId: string): void {
		try {
			removePaneRecord(blockId);
			const blocks = group.blocks.get(sessionId);
			blocks?.delete(blockId);
			if (blocks?.size === 0) group.blocks.delete(sessionId);
		} catch (error) {
			this.#warn(error);
		}
	}

	async #closeBlock(group: Group, sessionId: string, blockId: string): Promise<void> {
		await this.deps.rex.closeBlock(sessionId, blockId);
		this.#removeRecord(group, sessionId, blockId);
	}

	async #killSession(group: Group, sessionId: string): Promise<void> {
		await this.deps.rex.killSession(sessionId);
		for (const blockId of group.blocks.get(sessionId) ?? []) this.#removeRecord(group, sessionId, blockId);
	}

	async #killEmpty(group: Group): Promise<void> {
		if (!group.sessionId) return;
		for (const member of group.members) if (member.gate.held) return;
		for (const member of group.members) if (member.active) return;
		const sessionId = group.sessionId;
		group.sessionId = undefined;
		group.label = undefined;
		try {
			await this.#killSession(group, sessionId);
		} finally {
			// Request collection of closed pane trees without blocking the main TUI.
			Bun.gc(false);
		}
	}

	async #label(group: Group): Promise<void> {
		if (this.#disposed || !group.sessionId) return;
		let count = 0;
		for (const member of group.members) if (member.active) count++;
		const label = `omp: ${group.first}${count > 1 ? ` +${count - 1}` : ""}`;
		if (label === group.label) return;
		await this.deps.rex.renameSession(group.sessionId, label);
		group.label = label;
	}

	async #close(member: Member): Promise<void> {
		const active = member.active;
		if (this.#disposed || !active) return;
		member.active = undefined;
		member.gate.clear();
		this.#forgetFinished(member);
		if (member.group.sessionId) {
			await this.#closeBlock(member.group, member.group.sessionId, active.blockId).catch(error => this.#warn(error));
		}
		await active.pane.dispose().catch(error => this.#warn(error));
		await this.#killEmpty(member.group).catch(error => this.#warn(error));
		await this.#label(member.group).catch(error => this.#warn(error));
	}

	async #open(member: Member, session: AgentSession | null): Promise<void> {
		const group = member.group;
		let opened: Promise<{ pane: OpenPane } | { error: unknown }> | undefined;
		let block: string | undefined;
		try {
			const token = this.deps.newToken();
			// Register HELLO before Rex can start the relay. Observe early rejection too.
			opened = this.deps.openPane(member.id, session, token).then(
				pane => ({ pane }),
				error => ({ error }),
			);
			const argv = [this.deps.relayPath, this.deps.socketPath, await this.deps.prepareToken(token)];
			if (!group.sessionId) {
				const label = `omp: ${group.first}`;
				const created = await this.deps.rex.newSession(label, member.id, `omp: ${member.id}`, argv);
				group.sessionId = created.sessionId;
				group.label = label;
				block = created.blockId;
			} else {
				const tab = Math.floor(member.slot / 4);
				const peers = [...group.members].filter(other => Math.floor(other.slot / 4) === tab && other.active);
				const slot = member.slot % 4;
				const anchorSlot = slot === 3 ? member.slot - 2 : member.slot - slot;
				const anchor = peers.find(other => other.slot === anchorSlot) ?? peers[0];
				if (anchor?.active) {
					const direction = !member.everOpened && slot === 1 && anchor.slot === anchorSlot ? "right" : "below";
					block = (
						await this.deps.rex.split(
							group.sessionId,
							anchor.active.blockId,
							direction,
							`omp: ${member.id}`,
							argv,
						)
					).blockId;
				} else {
					block = (await this.deps.rex.newWindow(group.sessionId, member.id, `omp: ${member.id}`, argv)).blockId;
				}
			}
			const sessionId = group.sessionId;
			if (!sessionId) throw new Error("Pane group lost its session");
			let blocks = group.blocks.get(sessionId);
			if (!blocks) group.blocks.set(sessionId, (blocks = new Set()));
			blocks.add(block);
			writePaneRecord(block, { kind: "relay", pid: process.pid, group: true, label: `omp: ${member.id}` });
			const result = await opened;
			if ("error" in result) throw result.error;
			const active = { session, blockId: block, pane: result.pane };
			member.active = active;
			member.previousBlockId = member.lastBlockId;
			member.lastBlockId = block;
			member.gate.clear();
			result.pane.setTab?.(member.tab);
			if (!session) await this.#finish(member);
			member.everOpened = true;
			void result.pane.closed
				.then(() => {
					if (this.#disposed || member.active !== active) return;
					member.active = undefined;
					member.requested = false;
					this.#forgetFinished(member);
					member.gate.disconnected();
					this.#queue(group, async () => {
						await active.pane.dispose().catch(error => this.#warn(error));
						await this.#killEmpty(group);
					});
				})
				.catch(error => this.#warn(error));
			if (this.#disposed) {
				await this.#close(member);
				return;
			}
			await this.#label(group).catch(error => this.#warn(error));
			if (member.active === active) this.deps.onPaneOpened(member.id);
		} catch (error) {
			member.failed = member.session === session;
			this.#warn(error);
			if (member.active) {
				await this.#close(member);
			} else {
				if (!this.#disposed && block && group.sessionId)
					await this.#closeBlock(group, group.sessionId, block).catch(error => this.#warn(error));
				const result = await opened;
				if (result && "pane" in result) await result.pane.dispose().catch(error => this.#warn(error));
				await this.#killEmpty(group).catch(error => this.#warn(error));
			}
		}
	}

	dispose(): Promise<void> {
		if (this.#disposePromise) return this.#disposePromise;
		this.#disposed = true;
		for (const unsubscribe of this.#unsubscribers) unsubscribe();
		for (const member of this.#members.values()) member.gate.clear();
		this.#finished.length = 0;
		this.#unsubscribers.length = 0;
		for (const group of this.#groups.values()) {
			this.#queue(group, async () => {
				const sessionIds = new Set(group.blocks.keys());
				if (group.sessionId) sessionIds.add(group.sessionId);
				group.sessionId = undefined;
				group.label = undefined;
				for (const sessionId of sessionIds)
					await this.#killSession(group, sessionId).catch(error => this.#warn(error));
				for (const member of group.members) {
					member.session = null;
					const active = member.active;
					member.active = undefined;
					if (active) await active.pane.dispose().catch(error => this.#warn(error));
				}
			});
		}
		this.#disposePromise = Promise.all([...this.#groups.values()].map(group => group.tail)).then(() => {
			this.#members.clear();
			this.#groups.clear();
			Bun.gc(false);
		});
		return this.#disposePromise;
	}
}
