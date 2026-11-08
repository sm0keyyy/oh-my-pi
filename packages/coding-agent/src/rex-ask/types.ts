import { type } from "@oh-my-pi/omptype";

export const askSourceSchema = type({
	agent: "string",
	"role?": "string",
	"sessionId?": "string",
	"sessionLabel?": "string",
});

export interface AskSource {
	agent: string;
	role?: string;
	sessionId?: string;
	sessionLabel?: string;
}

export interface OperatorAskRequest {
	question: string;
	context?: string;
	source: AskSource;
	options?: { label: string; description?: string }[];
	allowFreeText: true;
	signal?: AbortSignal;
}

export type OperatorAskAnswer = { answer: string } | { cancelled: true };
