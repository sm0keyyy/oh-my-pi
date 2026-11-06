import { describe, expect, it } from "bun:test";
import { isKittyProtocolActive } from "@oh-my-pi/pi-tui/keys";
import { SocketTerminal } from "../../src/rex-panes/socket-terminal";

const options = { columns: 100, rows: 30, kittyEnableSequence: "\x1b[>5u", appearance: "dark" as const };

describe("SocketTerminal", () => {
	it("bounds 100 MiB of blocked frames and requests one full repaint on drain", () => {
		let blocked = true;
		let received = "";
		const terminal = new SocketTerminal(
			{
				write(data) {
					if (blocked) return 0;
					received += data;
					return Buffer.byteLength(data);
				},
				close() {},
			},
			options,
		);
		let repaints = 0;
		terminal.onRepaintNeeded(() => {
			repaints++;
			terminal.clearScreen();
			terminal.write("fresh frame");
		});
		const frame = "x".repeat(65536);
		for (let i = 0; i < 1600; i++) {
			terminal.write(frame);
			expect(terminal.pendingOutputBytes).toBeLessThanOrEqual(1024 * 1024);
		}
		expect(terminal.pendingOutputBytes).toBe(1024 * 1024);
		blocked = false;
		terminal.drained();
		terminal.drained();
		expect(terminal.pendingOutputBytes).toBe(0);
		expect(repaints).toBe(1);
		expect(received.endsWith("\x1b[2J\x1b[Hfresh frame")).toBe(true);
	});

	it("mirrors kitty and appearance without changing main state; closes once", () => {
		const before = isKittyProtocolActive();
		let output = "";
		let closes = 0;
		const terminal = new SocketTerminal(
			{
				write(data) {
					output += data;
					return Buffer.byteLength(data);
				},
				close() {
					closes++;
				},
			},
			options,
		);
		let input = "";
		let resized = "";
		let disconnects = 0;
		terminal.onAppearanceChange(() => {
			throw new Error("Pane appearance callback must not fire");
		});
		terminal.start(
			data => {
				input += data;
			},
			() => {
				resized = `${terminal.columns}x${terminal.rows}`;
			},
			() => disconnects++,
		);
		terminal.feedInput("\x1b[A\x03é");
		terminal.resize(120, 40);
		terminal.setTitle("must not appear");
		terminal.setProgress(true);
		expect(output).toBe("\x1b[?2004h\x1b[>5u");
		expect(input).toBe("\x1b[A\x03é");
		expect(resized).toBe("120x40");
		expect(terminal.appearance).toBe("dark");
		terminal.stop();
		terminal.stop();
		terminal.hostClosed();
		expect(output).toContain("\x1b[<u");
		expect(isKittyProtocolActive()).toBe(before);
		expect(closes).toBe(1);
		expect(disconnects).toBe(0);
		const lost = new SocketTerminal({ write: () => 0, close() {} }, options);
		lost.start(
			() => {},
			() => {},
			() => disconnects++,
		);
		lost.hostClosed();
		lost.hostClosed();
		expect(disconnects).toBe(1);
		expect(lost.pendingOutputBytes).toBe(0);
	});

	it("preserves UTF-8 across code-point-aligned partial writes", () => {
		let output = "";
		let partial = true;
		const terminal = new SocketTerminal(
			{
				write(data) {
					if (partial) {
						partial = false;
						output += data[0];
						return 1;
					}
					output += data;
					return Buffer.byteLength(data);
				},
				close() {},
			},
			options,
		);
		terminal.write("aé猫");
		expect(terminal.pendingOutputBytes).toBe(5);
		terminal.drained();
		expect(output).toBe("aé猫");
	});
});
