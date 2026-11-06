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

export interface OpenPane {
	readonly ui: ExtensionUIContext;
	readonly closed: Promise<void>;
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
	openPane(agentId: string, session: AgentSession, token: string): Promise<OpenPane>;
	onPaneOpened(agentId: string): void;
}

export interface PaneManager {
	paneUi(agentId: string): ExtensionUIContext | undefined;
	location(agentId: string): RexLocation | undefined;
	reveal(agentId: string): Promise<boolean>;
	dispose(): Promise<void>;
}

interface ActivePane {
	session: AgentSession;
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
}

interface Group {
	first: string;
	members: Set<Member>;
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
	#disposed = false;
	#warned = false;
	#disposePromise?: Promise<void>;

	constructor(readonly deps: PaneManagerDeps) {
		this.#unsubscribers = [
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
					member.group.members.delete(member);
					this.#members.delete(member.id);
					if (member.group.members.size === 0 && !member.group.sessionId) {
						for (const [key, group] of this.#groups) if (group === member.group) this.#groups.delete(key);
					}
				});
			}),
		];
	}

	paneUi(agentId: string): ExtensionUIContext | undefined {
		return this.#members.get(agentId)?.active?.pane.ui;
	}

	location(agentId: string): RexLocation | undefined {
		const member = this.#members.get(agentId);
		const sessionId = member?.group.sessionId;
		return sessionId && member?.active ? { sessionId, blockId: member.active.blockId } : undefined;
	}

	async reveal(agentId: string): Promise<boolean> {
		if (this.#disposed || !this.#live(this.deps.registry.get(agentId))) return false;
		if (!this.#members.has(agentId)) this.#started(agentId, undefined);
		const member = this.#members.get(agentId);
		if (!member) return false;
		member.failed = false;
		this.#changed(agentId);
		let revealed = false;
		this.#queue(member.group, async () => {
			const location = this.location(agentId);
			if (this.#disposed || !location) return;
			await this.deps.rex.focusBlock(location.sessionId, location.blockId);
			revealed = true;
		});
		await member.group.tail;
		return revealed;
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

	#started(id: string, parentToolCallId: string | undefined): void {
		if (this.#disposed) return;
		const ref = this.deps.registry.get(id);
		if (!this.#live(ref)) return;
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
					group = { first: id, members: new Set(), nextSlot: 0, tail: Promise.resolve() };
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
		const session = this.#live(this.deps.registry.get(id));
		if (member.session !== session) member.failed = false;
		member.session = session;
		member.requested = session !== null;
		if (member.queued || member.active?.session === session || (!member.active && (!session || member.failed)))
			return;
		member.queued = true;
		this.#queue(member.group, async () => {
			try {
				if (this.#disposed) return;
				if (member.active && member.active.session !== member.session) await this.#close(member);
				const desired = member.session;
				if (!desired || member.active || member.failed || !member.requested) return;
				member.requested = false;
				await this.#open(member, desired);
			} finally {
				member.queued = false;
				if (
					!this.#disposed &&
					(member.active
						? member.active.session !== member.session
						: member.session && member.requested && !member.failed)
				)
					this.#changed(id);
			}
		});
	}

	async #killEmpty(group: Group): Promise<void> {
		if (!group.sessionId) return;
		for (const member of group.members) if (member.active) return;
		const sessionId = group.sessionId;
		group.sessionId = undefined;
		group.label = undefined;
		try {
			await this.deps.rex.killSession(sessionId);
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
		try {
			removePaneRecord(active.blockId);
		} catch (error) {
			this.#warn(error);
		}
		if (member.group.sessionId) {
			await this.deps.rex.closeBlock(member.group.sessionId, active.blockId).catch(error => this.#warn(error));
		}
		await active.pane.dispose().catch(error => this.#warn(error));
		await this.#killEmpty(member.group).catch(error => this.#warn(error));
		await this.#label(member.group).catch(error => this.#warn(error));
	}

	async #open(member: Member, session: AgentSession): Promise<void> {
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
					block = (await this.deps.rex.newWindow(group.sessionId, `omp: ${member.id}`, argv)).blockId;
				}
			}
			writePaneRecord(block, { kind: "relay", pid: process.pid, group: true });
			const result = await opened;
			if ("error" in result) throw result.error;
			const active = { session, blockId: block, pane: result.pane };
			member.active = active;
			member.everOpened = true;
			void result.pane.closed
				.then(() => {
					if (this.#disposed || member.active !== active) return;
					member.active = undefined;
					member.requested = false;
					try {
						removePaneRecord(active.blockId);
					} catch (error) {
						this.#warn(error);
					}
					this.#queue(group, async () => {
						await active.pane.dispose().catch(error => this.#warn(error));
						await this.#killEmpty(group);
					});
				})
				.catch(error => this.#warn(error));
			if (this.#disposed || member.session !== session) {
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
				if (block) {
					try {
						removePaneRecord(block);
					} catch (cleanup) {
						this.#warn(cleanup);
					}
				}
				if (!this.#disposed && block && group.sessionId)
					await this.deps.rex.closeBlock(group.sessionId, block).catch(error => this.#warn(error));
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
		this.#unsubscribers.length = 0;
		for (const group of this.#groups.values()) {
			this.#queue(group, async () => {
				const sessionId = group.sessionId;
				group.sessionId = undefined;
				group.label = undefined;
				if (sessionId) await this.deps.rex.killSession(sessionId).catch(error => this.#warn(error));
				for (const member of group.members) {
					member.session = null;
					const active = member.active;
					member.active = undefined;
					if (active) {
						try {
							removePaneRecord(active.blockId);
						} catch (error) {
							this.#warn(error);
						}
					}
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
