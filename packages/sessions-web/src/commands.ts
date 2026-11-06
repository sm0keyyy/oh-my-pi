// Generated from the TUI input contracts by scripts/command-contract.ts.
export const enum Effort {
	Minimal = "minimal",
	Low = "low",
	Medium = "medium",
	High = "high",
	XHigh = "xhigh",
	Max = "max",
}
export const ThinkingLevel = {
	Inherit: "inherit",
	Off: "off",
	Minimal: Effort.Minimal,
	Low: Effort.Low,
	Medium: Effort.Medium,
	High: Effort.High,
	XHigh: Effort.XHigh,
	Max: Effort.Max,
} as const;
export type ThinkingLevel = (typeof ThinkingLevel)[keyof typeof ThinkingLevel];
export interface ProviderFileReference {
	provider: "openai" | "anthropic" | "google";
	id?: string;
	uri?: string;
	expiresAt?: number;
}
export interface ImageContent {
	type: "image";
	data: string;
	mimeType: string;
	detail?: "auto" | "low" | "high" | "original";
	providerFile?: ProviderFileReference;
	url?: string;
}
export type TodoStatus = "pending" | "in_progress" | "completed" | "abandoned" | "blocked";
export interface TodoItem {
	content: string;
	status: TodoStatus;
	id?: string;
	blocker?: string;
	details?: string;
	notes?: string[];
}
export interface TodoPhase {
	name: string;
	tasks: TodoItem[];
	id?: string;
}
export type CacheWarmingMode = "off" | "streaming" | "idle";
export type RpcGoalOp = "get" | "create" | "resume" | "pause" | "drop";
export type RpcMessageUpdates = "full" | "delta";
export type RpcCommand =
	| {
			id?: string;
			type: "negotiate_protocol";
			protocolVersion: number;
	  }
	| {
			id?: string;
			type: "prompt";
			message: string;
			images?: ImageContent[];
			streamingBehavior?: "steer" | "followUp";
	  }
	| {
			id?: string;
			type: "steer";
			message: string;
			images?: ImageContent[];
	  }
	| {
			id?: string;
			type: "follow_up";
			message: string;
			images?: ImageContent[];
	  }
	| {
			id?: string;
			type: "remove_queued_message";
			message: string;
			queue: "steering" | "followUp";
	  }
	| {
			id?: string;
			type: "promote_queued_message";
			message: string;
	  }
	| {
			id?: string;
			type: "abort";
	  }
	| {
			id?: string;
			type: "abort_and_prompt";
			message: string;
			images?: ImageContent[];
	  }
	| {
			id?: string;
			type: "abort_and_restore_queue";
	  }
	| {
			id?: string;
			type: "new_session";
			parentSession?: string;
	  }
	| {
			id?: string;
			type: "open_session";
			sessionDir: string;
			provider?: string;
			modelId?: string;
	  }
	| {
			id?: string;
			type: "get_state";
	  }
	| {
			id?: string;
			type: "set_fast_mode";
			enabled: boolean;
	  }
	| {
			id?: string;
			type: "set_slow_mode";
			enabled: boolean;
	  }
	| {
			id?: string;
			type: "goal";
			op: RpcGoalOp;
			objective?: string;
			token_budget?: number;
	  }
	| {
			id?: string;
			type: "set_ask_dialog";
			enabled: boolean;
	  }
	| {
			id?: string;
			type: "set_review_dialog";
			enabled: boolean;
	  }
	| {
			id?: string;
			type: "get_available_commands";
	  }
	| {
			id?: string;
			type: "get_entries";
			since?: string;
	  }
	| {
			id?: string;
			type: "get_tree";
	  }
	| {
			id?: string;
			type: "set_todos";
			phases: TodoPhase[];
	  }
	| {
			id?: string;
			type: "set_subagent_subscription";
			level: RpcSubagentSubscriptionLevel;
	  }
	| {
			id?: string;
			type: "set_event_filter";
			events: string[] | null;
			messageUpdates?: RpcMessageUpdates;
	  }
	| {
			id?: string;
			type: "get_subagents";
	  }
	| {
			id?: string;
			type: "get_subagent_messages";
			subagentId?: string;
			sessionFile?: string;
			fromByte?: number;
	  }
	| {
			id?: string;
			type: "cancel_subagent";
			subagentId: string;
	  }
	| {
			id?: string;
			type: "steer_subagent";
			subagentId: string;
			message: string;
	  }
	| {
			id?: string;
			type: "stop_subagent";
			subagentId: string;
			reason: string;
	  }
	| {
			id?: string;
			type: "abort_subagent";
			subagentId: string;
			reason?: string;
	  }
	| {
			id?: string;
			type: "follow_up_subagent";
			subagentId: string;
			message: string;
	  }
	| {
			id?: string;
			type: "toggle_pane";
			pane: "todo" | "agents";
			shape?: "dock" | "float";
	  }
	| {
			id?: string;
			type: "live_start";
			voice?: string;
			instructions?: string;
	  }
	| {
			id?: string;
			type: "live_connect";
			sdpOffer: string;
			voice?: string;
			instructions?: string;
	  }
	| {
			id?: string;
			type: "live_stop";
	  }
	| {
			id?: string;
			type: "live_mute";
			muted?: boolean;
	  }
	| {
			id?: string;
			type: "dictation_start";
			captureId: string;
	  }
	| {
			id?: string;
			type: "dictation_stop";
	  }
	| {
			id?: string;
			type: "set_model";
			provider: string;
			modelId: string;
	  }
	| {
			id?: string;
			type: "cycle_model";
	  }
	| {
			id?: string;
			type: "get_available_models";
	  }
	| {
			id?: string;
			type: "set_thinking_level";
			level: ThinkingLevel;
	  }
	| {
			id?: string;
			type: "cycle_thinking_level";
	  }
	| {
			id?: string;
			type: "get_available_thinking_levels";
	  }
	| {
			id?: string;
			type: "set_steering_mode";
			mode: "all" | "one-at-a-time";
	  }
	| {
			id?: string;
			type: "set_follow_up_mode";
			mode: "all" | "one-at-a-time";
	  }
	| {
			id?: string;
			type: "set_interrupt_mode";
			mode: "immediate" | "wait";
	  }
	| {
			id?: string;
			type: "compact";
			customInstructions?: string;
	  }
	| {
			id?: string;
			type: "set_auto_compaction";
			enabled: boolean;
	  }
	| {
			id?: string;
			type: "set_cache_warming";
			mode: CacheWarmingMode;
	  }
	| {
			id?: string;
			type: "set_auto_retry";
			enabled: boolean;
	  }
	| {
			id?: string;
			type: "abort_retry";
	  }
	| {
			id?: string;
			type: "bash";
			command: string;
	  }
	| {
			id?: string;
			type: "abort_bash";
	  }
	| {
			id?: string;
			type: "get_session_stats";
	  }
	| {
			id?: string;
			type: "get_session_lease";
			sessionIds: string[];
	  }
	| {
			id?: string;
			type: "export_html";
			outputPath?: string;
	  }
	| {
			id?: string;
			type: "switch_session";
			sessionPath: string;
			provider?: string;
			modelId?: string;
	  }
	| {
			id?: string;
			type: "branch";
			entryId: string;
	  }
	| {
			id?: string;
			type: "fork";
			entryId?: string;
	  }
	| {
			id?: string;
			type: "navigate_tree";
			entryId: string;
			summarize?: boolean;
			customInstructions?: string;
	  }
	| {
			id?: string;
			type: "abort_branch_summary";
	  }
	| {
			id?: string;
			type: "set_label";
			entryId: string;
			label?: string;
	  }
	| {
			id?: string;
			type: "get_branch_messages";
	  }
	| {
			id?: string;
			type: "get_last_assistant_text";
	  }
	| {
			id?: string;
			type: "set_session_name";
			name: string;
	  }
	| {
			id?: string;
			type: "handoff";
			customInstructions?: string;
	  }
	| {
			id?: string;
			type: "get_messages";
	  }
	| {
			id?: string;
			type: "get_messages_page";
			cursor?: string;
			limit?: number;
			backward?: boolean;
	  }
	| {
			id?: string;
			type: "get_login_providers";
	  }
	| {
			id?: string;
			type: "login";
			providerId: string;
	  }
	| {
			id?: string;
			type: "get_logout_accounts";
			providerId: string;
	  }
	| {
			id?: string;
			type: "logout";
			providerId: string;
			credentialId: number;
	  }
	| {
			id?: string;
			type: "predict_word";
			text: string;
			cursor: number;
	  }
	| {
			id?: string;
			type: "predict_word_feedback";
			text: string;
			cursor: number;
			suggestion: string;
			accepted: boolean;
	  }
	| {
			id?: string;
			type: "btw";
			question: string;
			recordId?: string;
	  }
	| {
			id?: string;
			type: "btw_cancel";
			recordId?: string;
	  }
	| {
			id?: string;
			type: "get_btw_history";
	  };
export type RpcSubagentSubscriptionLevel = "off" | "progress" | "events";
export type RpcExtensionUIResponse =
	| {
			type: "extension_ui_response";
			id: string;
			value: string;
	  }
	| {
			type: "extension_ui_response";
			id: string;
			confirmed: boolean;
	  }
	| {
			type: "extension_ui_response";
			id: string;
			cancelled: true;
			timedOut?: boolean;
	  }
	| {
			type: "extension_ui_response";
			id: string;
			review: {
				verdict: "approve" | "request-changes";
				comments: Array<{
					section: string;
					text: string;
				}>;
			};
	  }
	| {
			type: "extension_ui_response";
			id: string;
			answers: Array<{
				id: string;
				selectedOptions: string[];
				customInput?: string;
			}>;
	  };
export const terminalCommands = [
	{
		name: "settings",
		description: "Open settings menu",
		source: "builtin",
	},
	{
		name: "setup",
		description: "Open provider setup",
		source: "builtin",
	},
	{
		name: "plan",
		description: "Toggle plan mode (agent plans before executing)",
		source: "builtin",
	},
	{
		name: "plan-review",
		description: "Re-open the plan review for the latest plan (plan mode only)",
		source: "builtin",
	},
	{
		name: "vibe",
		description: "Toggle vibe mode (direct persistent fast/good worker sessions; read-only toolset)",
		source: "builtin",
	},
	{
		name: "goal",
		description: "Toggle goal mode (persistent autonomous objective for this session)",
		source: "builtin",
	},
	{
		name: "guided-goal",
		description: "Have the agent interview you in chat, then set up goal mode",
		source: "builtin",
	},
	{
		name: "loop",
		description: "Toggle loop mode",
		source: "builtin",
	},
	{
		name: "queue",
		description: "Queue a message for after the agent yields",
		source: "builtin",
	},
	{
		name: "collab",
		description: "Share this session live via a relay",
		source: "builtin",
	},
	{
		name: "join",
		description: "Join a shared collab session",
		source: "builtin",
	},
	{
		name: "leave",
		description: "Leave the collab session",
		source: "builtin",
	},
	{
		name: "copy",
		description: "Pick text or code from the conversation to copy",
		source: "builtin",
	},
	{
		name: "open",
		description: "Open the last link from the conversation in your browser (or pick one with /copy)",
		source: "builtin",
	},
	{
		name: "hotkeys",
		description: "Show all keyboard shortcuts",
		source: "builtin",
	},
	{
		name: "extensions",
		description: "Open Extension Control Center dashboard",
		source: "builtin",
	},
	{
		name: "agents",
		description: "Open the agents hub (per-agent model, prewalk, and advisor)",
		source: "builtin",
	},
	{
		name: "git",
		description: "Open the git UI (split diff viewer, staging, commit composer)",
		source: "builtin",
	},
	{
		name: "local",
		description: "Open a session local:// file in $EDITOR (picker when no name given)",
		source: "builtin",
	},
	{
		name: "hub",
		description: "Open the live Agent Hub (subagents, including finished ones)",
		source: "builtin",
	},
	{
		name: "branch",
		description: "Rewind to a previous message, keeping the old path as a branch",
		source: "builtin",
	},
	{
		name: "fork",
		description: "Fork this session, or open it in a multiplexer pane or window",
		source: "builtin",
	},
	{
		name: "tree",
		description: "Navigate session tree (switch branches)",
		source: "builtin",
	},
	{
		name: "login",
		description: "Login with OAuth provider",
		source: "builtin",
	},
	{
		name: "logout",
		description: "Logout from OAuth provider",
		source: "builtin",
	},
	{
		name: "new",
		description: "Start a new session",
		source: "builtin",
	},
	{
		name: "clear",
		description: "Clear the conversation context in place, keeping the session",
		source: "builtin",
	},
	{
		name: "delete",
		description: "Delete the current session and start a new one",
		source: "builtin",
	},
	{
		name: "resume",
		description: "Resume a different session",
		source: "builtin",
	},
	{
		name: "btw",
		description: "Ask a side question, or browse this session's BTW history",
		source: "builtin",
	},
	{
		name: "tan",
		description: "Run a full background agent on tangential work",
		source: "builtin",
	},
	{
		name: "omfg",
		description: "Forge a TTSR rule from a complaint to stop a recurring behavior",
		source: "builtin",
	},
	{
		name: "cleanse",
		description: "Detect and fix project diagnostics with weighted parallel subagents",
		source: "builtin",
	},
	{
		name: "debug",
		description: "Open debug tools selector",
		source: "builtin",
	},
	{
		name: "exit",
		description: "Exit the application",
		source: "builtin",
	},
	{
		name: "restart",
		description: "Restart omp with the same launch flags, resuming this session",
		source: "builtin",
	},
	{
		name: "skills",
		description: "Search, install, and update skills from the skills.omp.sh registry",
		source: "builtin",
	},
	{
		name: "live",
		description: "Start Codex-backed realtime voice mode",
		source: "builtin",
	},
	{
		name: "record",
		description: "Start or stop recording this screen to a replayable file (omp play)",
		source: "builtin",
	},
	{
		name: "pause",
		description: "Freeze all agents (main, subagents, advisor) until resumed",
		source: "builtin",
	},
	{
		name: "quit",
		description: "Quit the application",
		source: "builtin",
	},
] as const;
