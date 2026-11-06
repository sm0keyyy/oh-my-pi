/**
 * The agent's run status, published to every terminal surface that shows it:
 * the title's run-state separator, and the root record of the OSC 7501 Program
 * Status Protocol (https://mitchellh.com/writing/program-status-osc7501),
 * which tabs, multiplexers, and agent inboxes read from the PTY instead of
 * scraping the title.
 *
 * A report replaces the terminal's record whole, so each one carries `app` and
 * the full status. omp only writes the root record; teardown and opting out
 * send `state=clear` so no stale record outlives the session.
 */
import { writeTerminalSequence } from "@oh-my-pi/pi-tui";
import type { Terminal } from "@oh-my-pi/pi-tui/terminal";
import { truncateLineBytes } from "@oh-my-pi/pi-tui/tools/streaming-output";
import { APP_NAME, isTerminalHeadless, sanitizeText } from "@oh-my-pi/pi-utils";
import { setTerminalTitleState, type TerminalTitleState } from "./title-generator";

/** What a blocked run waits on: an approval prompt or an `ask` question. */
export type BlockedKind = "permission" | "question";

/**
 * The agent's run status, in OSC 7501 terms:
 * - `idle`: at the prompt waiting for an instruction, including after the user interrupts a run;
 * - `working`: running;
 * - `blocked`: waiting on the user; `msg` says for what;
 * - `done`: finished a turn whose result the user has not looked at yet;
 * - `error`: the turn failed; `msg` says why.
 */
export type RunStatus =
	| { readonly state: "idle" | "working" | "done" }
	| { readonly state: "blocked"; readonly kind: BlockedKind; readonly msg?: string }
	| { readonly state: "error"; readonly msg?: string };

const OSC_7501 = "\x1b]7501;";
const ST = "\x1b\\";
/** Removes every record on the terminal: the protocol has no id for the root alone. */
const CLEAR_REPORT = `${OSC_7501}state=clear${ST}`;
/** The protocol's decoded `msg` limit; its base64 form stays within the 2732-byte encoded limit. */
const MSG_MAX_BYTES = 2048;

function titleState(status: RunStatus): TerminalTitleState {
	if (status.state === "working") return "working";
	if (status.state === "blocked") return "attention";
	return "idle";
}

/**
 * Base64 of `text` as one line of control-free UTF-8 within the `msg` limit, or
 * undefined when nothing printable remains. A terminal discards the whole
 * report when decoded text holds a control character.
 */
function encodeMsg(text: string | undefined): string | undefined {
	if (!text) return undefined;
	const line = sanitizeText(text).replace(/\s+/g, " ").trim();
	if (!line) return undefined;
	return Buffer.from(truncateLineBytes(line, MSG_MAX_BYTES).text).toString("base64");
}

function formatReport(status: RunStatus): string {
	let body = `state=${status.state}`;
	if (status.state === "blocked") body += `:kind=${status.kind}`;
	body += `:app=${APP_NAME}`;
	const msg = encodeMsg(status.state === "blocked" || status.state === "error" ? status.msg : undefined);
	if (msg) body += `:msg=${msg}`;
	return `${OSC_7501}${body}${ST}`;
}

/** Owns one terminal's run status. Injected terminals never change the main title. */
export class RunStatusReporter {
	#status: RunStatus = { state: "idle" };
	#enabled = true;
	#disposed = false;
	#reported: string | undefined;

	constructor(private readonly terminal?: Terminal) {}

	#report(): void {
		if (this.#disposed || !this.#enabled) return;
		if (!this.terminal && (!process.stdout.isTTY || isTerminalHeadless())) return;
		const next = formatReport(this.#status);
		if (next === this.#reported) return;
		if (this.terminal) this.terminal.write(next);
		else writeTerminalSequence(next);
		this.#reported = next;
	}

	#clear(): void {
		if (this.#reported === undefined) return;
		this.#reported = undefined;
		if (this.terminal) this.terminal.write(CLEAR_REPORT);
		else writeTerminalSequence(CLEAR_REPORT);
	}

	setRunStatus(status: RunStatus): void {
		this.#status = status;
		if (!this.terminal) setTerminalTitleState(titleState(status));
		this.#report();
	}

	setProgramStatusEnabled(enabled: boolean): void {
		this.#enabled = enabled;
		if (enabled) this.#report();
		else this.#clear();
	}

	resendProgramStatus(): void {
		if (this.#status.state === "done" || this.#status.state === "error") return;
		this.#reported = undefined;
		this.#report();
	}

	initProgramStatus(): void {
		this.#disposed = false;
	}

	disposeProgramStatus(): void {
		this.#clear();
		this.#disposed = true;
	}
}
