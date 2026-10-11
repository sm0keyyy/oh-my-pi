import { TOKEN } from "../../sessions-gateway/src/protocol";

export const BRIDGE_CREDENTIAL = { service: "omp-sessions-bridge", name: "bridge" };
export interface Keychain {
	get(credential: { service: string; name: string }): Promise<string | null>;
	set(credential: { service: string; name: string; value: string }): Promise<void>;
}

export async function readBridgeHeaders(keychain: Keychain = Bun.secrets): Promise<Record<string, string>> {
	const [token, clientId, clientSecret] = await Promise.all([
		keychain.get(BRIDGE_CREDENTIAL),
		keychain.get({ service: "omp-collab-cf-access", name: "client-id" }),
		keychain.get({ service: "omp-collab-cf-access", name: "client-secret" }),
	]);
	if (!token || !TOKEN.test(token) || !clientId || !clientSecret || /[\r\n]/.test(clientId + clientSecret)) {
		throw new Error("Sessions bridge Keychain credentials are missing or invalid");
	}
	return {
		Authorization: `Bearer ${token}`,
		"CF-Access-Client-Id": clientId,
		"CF-Access-Client-Secret": clientSecret,
	};
}
