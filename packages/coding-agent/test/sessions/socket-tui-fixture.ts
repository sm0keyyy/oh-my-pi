import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { InteractiveMode } from "../../src/modes/interactive-mode";
import { AgentSession } from "../../src/session/agent-session";
import { AuthStorage } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";

/** @internal Startup receipt for the isolated TUI fixture. */
export interface SocketTuiReady {
	instanceId: string;
	sessionId: string;
	endpoint: string;
}

const dir = process.argv[2];
if (!dir) throw new Error("A private fixture directory is required");
initTheme();
await Settings.init({ inMemory: true, cwd: dir });
const auth = await AuthStorage.create(path.join(dir, "auth.db"));
const registry = new ModelRegistry(auth, path.join(dir, "models.yml"));
const model = registry.find("anthropic", "claude-sonnet-4-5");
const session = new AgentSession({
	agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [] } }),
	sessionManager: SessionManager.create(dir, path.join(dir, "sessions")),
	settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false }),
	modelRegistry: registry,
});
const mode = new InteractiveMode(
	session,
	"test",
	undefined,
	() => {},
	undefined,
	undefined,
	undefined,
	new Composer({ terminal: new VirtualTerminal(120, 32) }),
);
await mode.init({ suppressWelcomeIntro: true });
const discovery = path.join(dir, "discovery");
await mode.startRpcSocket({ dir: discovery });
const files = await Array.fromAsync(new Bun.Glob("*.json").scan(discovery));
const meta = await Bun.file(path.join(discovery, files[0]!)).json();
const ready: SocketTuiReady = { instanceId: meta.instanceId, sessionId: session.sessionId, endpoint: meta.endpoint };
if (process.send) process.send(ready);
else console.log(`SOCKET_TUI_READY ${JSON.stringify(ready)}`);
await Promise.withResolvers<void>().promise;
