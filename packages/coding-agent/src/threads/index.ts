export type ThreadItem =
	| { kind: "brief" | "operator" | "reply" | "result"; text: string; ts: number; entryId?: string }
	| { kind: "irc-in" | "irc-out"; from: string; to: string; text: string; ts: number; messageId?: string }
	| { kind: "ask"; questions: string[]; ts: number; toolCallId: string }
	| { kind: "answer"; text: string; timedOut?: boolean; ts: number; toolCallId: string };

export interface AgentThread {
	agentId: string;
	sessionFile: string;
	items: ThreadItem[];
}

export interface FeedItem {
	from: string;
	to: string | "all";
	text: string;
	ts: number;
}

export * from "./build";
export * from "./read";
export * from "./feed";
