import { describe, expect, it } from "bun:test";
import { ExtensionRunner } from "../src/extensibility/extensions/runner";
import { SessionManager } from "../src/session/session-manager";

describe("ExtensionContext project trust compatibility", () => {
	it("reports project-local inputs as trusted", () => {
		const runner = new ExtensionRunner([], {} as never, "/project", SessionManager.inMemory(), {} as never);

		expect(runner.createContext().isProjectTrusted()).toBe(true);
	});
});
