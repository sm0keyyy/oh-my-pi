import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { ACCESS_AUDIENCE, ACCESS_ISSUER } from "../src/access";

const pair = generateKeyPair("RS256");
export interface AccessFixture {
	certsUrl: URL;
	headers: Record<string, string>;
	sign(overrides?: JWTPayload): Promise<string>;
	fetch(url: string, init?: RequestInit): Promise<Response>;
	stop(): void;
}
export async function createAccessFixture(): Promise<AccessFixture> {
	const keys = await pair;
	const jwk = { ...(await exportJWK(keys.publicKey)), kid: "test", alg: "RS256", use: "sig" };
	const certs = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ keys: [jwk] }) });
	const sign = (overrides: JWTPayload = {}): Promise<string> =>
		new SignJWT({
			aud: [ACCESS_AUDIENCE],
			iss: ACCESS_ISSUER,
			exp: Math.floor(Date.now() / 1000) + 3600,
			...overrides,
		})
			.setProtectedHeader({ alg: "RS256", kid: "test" })
			.sign(keys.privateKey);
	const headers = { "cf-access-jwt-assertion": await sign() };
	return {
		certsUrl: new URL(`http://127.0.0.1:${certs.port}/certs`),
		headers,
		sign,
		fetch(url, init = {}) {
			return fetch(url, { ...init, headers: { ...headers, ...init.headers } });
		},
		stop() {
			certs.stop(true);
		},
	};
}
