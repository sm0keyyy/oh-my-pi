import { BRIDGE_CREDENTIAL, type Keychain } from "./credentials";
import { TOKEN } from "../../sessions-gateway/src/protocol";

export const REMOTE_DIRECTORY = "/mnt/user/appdata/omp-sessions-gateway/secrets";
export const REMOTE_INSTALL = `set -eu
umask 077
dir=${REMOTE_DIRECTORY}
test ! -L "$dir"
mkdir -p "$dir"
chmod 700 "$dir"
test ! -L "$dir/.provision.lock"
exec 9>"$dir/.provision.lock"
flock -x 9
target="$dir/bridge-token"
tmp=$(mktemp "$dir/.bridge-token.XXXXXX")
trap 'rm -f "$tmp"' EXIT HUP INT TERM
cat > "$tmp"
if test -e "$target" || test -L "$target"; then
  test ! -L "$target" && test -f "$target"
  cmp -s "$tmp" "$target"
  chmod 600 "$target"
else
  ln "$tmp" "$target"
fi
chown 1000:1000 "$target"`;

export async function installRemoteToken(token: string): Promise<void> {
	const child = Bun.spawn(["ssh", "-o", "BatchMode=yes", "unraid", REMOTE_INSTALL], {
		stdin: new Blob([token]),
		stdout: "ignore",
		stderr: "ignore",
		timeout: 30_000,
	});
	if ((await child.exited) !== 0) {
		throw new Error("Bridge token installation failed. The unraid token must match the Keychain item.");
	}
}

export async function provisionBridgeCredentials(
	keychain: Keychain = Bun.secrets,
	install: (token: string) => Promise<void> = installRemoteToken,
): Promise<void> {
	let token = await keychain.get(BRIDGE_CREDENTIAL);
	if (token === null) {
		token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
		await keychain.set({ ...BRIDGE_CREDENTIAL, value: token });
	}
	if (!TOKEN.test(token)) throw new Error("Invalid bridge token in Keychain");
	await install(token);
}

if (import.meta.main) {
	if (process.platform !== "darwin") throw new Error("Provision the bridge token from the Mac");
	await provisionBridgeCredentials();
	process.stdout.write("Bridge token stored in Keychain and the unraid mode-0600 file. Value not displayed.\n");
}
