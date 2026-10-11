import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { BRIDGE_CREDENTIAL, readBridgeHeaders, type Keychain } from "../src/credentials";
import { provisionBridgeCredentials, REMOTE_DIRECTORY, REMOTE_INSTALL } from "../src/provision";

let root: string;
let keychain: Keychain;
let values: Map<string, string>;
let install: (token: string) => Promise<void>;
beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "sessions-credentials-test-"));
	values = new Map();
	keychain = {
		async get(credential) {
			return values.get(`${credential.service}:${credential.name}`) ?? null;
		},
		async set(credential) {
			values.set(`${credential.service}:${credential.name}`, credential.value);
		},
	};
	install = async token => {
		const command = REMOTE_INSTALL.replace(REMOTE_DIRECTORY, JSON.stringify(path.join(root, "secrets")));
		const child = Bun.spawn(["/bin/sh", "-c", `flock() { :; }; chown() { :; }; ${command}`], {
			stdin: new Blob([token]),
			stdout: "ignore",
			stderr: "ignore",
			timeout: 5_000,
		});
		if ((await child.exited) !== 0) throw new Error("Fake remote refused the token");
	};
});
afterEach(async () => {
	await fs.rm(root, { recursive: true });
});

test("reuses one Keychain token on two runs and installs a private remote file", async () => {
	await provisionBridgeCredentials(keychain, install);
	const token = values.get(`${BRIDGE_CREDENTIAL.service}:${BRIDGE_CREDENTIAL.name}`)!;
	expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
	const target = path.join(root, "secrets/bridge-token");
	expect(await Bun.file(target).text()).toBe(token);
	expect((await fs.stat(target)).mode & 0o777).toBe(0o600);
	expect((await fs.stat(path.dirname(target))).mode & 0o777).toBe(0o700);
	await provisionBridgeCredentials(keychain, install);
	expect(values.get(`${BRIDGE_CREDENTIAL.service}:${BRIDGE_CREDENTIAL.name}`)).toBe(token);
	expect(await Bun.file(target).text()).toBe(token);
});

test("refuses a changed unraid token without replacing either value", async () => {
	await provisionBridgeCredentials(keychain, install);
	const original = values.get(`${BRIDGE_CREDENTIAL.service}:${BRIDGE_CREDENTIAL.name}`);
	const target = path.join(root, "secrets/bridge-token");
	await Bun.write(target, "different token");
	await expect(provisionBridgeCredentials(keychain, install)).rejects.toThrow("Fake remote refused");
	expect(await Bun.file(target).text()).toBe("different token");
	expect(values.get(`${BRIDGE_CREDENTIAL.service}:${BRIDGE_CREDENTIAL.name}`)).toBe(original);
	expect((await fs.readdir(path.dirname(target))).sort()).toEqual([".provision.lock", "bridge-token"]);
});

test("refuses symlink targets without writing their destination", async () => {
	await fs.mkdir(path.join(root, "secrets"), { mode: 0o700 });
	const destination = path.join(root, "elsewhere");
	await Bun.write(destination, "preserve");
	await fs.symlink(destination, path.join(root, "secrets/bridge-token"));
	await expect(provisionBridgeCredentials(keychain, install)).rejects.toThrow("Fake remote refused");
	expect(await Bun.file(destination).text()).toBe("preserve");
});

test("keeps the Keychain item after remote failure and retries with the same token", async () => {
	await expect(
		provisionBridgeCredentials(keychain, async () => {
			throw new Error("offline");
		}),
	).rejects.toThrow("offline");
	const original = values.get(`${BRIDGE_CREDENTIAL.service}:${BRIDGE_CREDENTIAL.name}`)!;
	await provisionBridgeCredentials(keychain, install);
	expect(await Bun.file(path.join(root, "secrets/bridge-token")).text()).toBe(original);
});

test("reads the approved Keychain accounts and fails before missing credentials can connect", async () => {
	await expect(readBridgeHeaders(keychain)).rejects.toThrow("missing or invalid");
	await provisionBridgeCredentials(keychain, install);
	values.set("omp-collab-cf-access:client-id", "fake-client-id");
	values.set("omp-collab-cf-access:client-secret", "fake-client-secret");
	expect(await readBridgeHeaders(keychain)).toEqual({
		Authorization: `Bearer ${values.get("omp-sessions-bridge:bridge")}`,
		"CF-Access-Client-Id": "fake-client-id",
		"CF-Access-Client-Secret": "fake-client-secret",
	});
	values.set("omp-sessions-bridge:bridge", "invalid");
	await expect(provisionBridgeCredentials(keychain, install)).rejects.toThrow("Invalid bridge token");
});
