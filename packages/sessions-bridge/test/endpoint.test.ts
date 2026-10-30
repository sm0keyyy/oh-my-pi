import { afterEach, expect, spyOn, test, vi } from "bun:test";
import { selectBridgeEndpoint } from "../src/endpoint";

const url = "wss://sessions.the-freed.family/ws/bridge";
const origin = "https://10.0.0.13:44301";
const headers = { Authorization: "Bearer fixture", "CF-Access-Client-Secret": "fixture-secret" };

afterEach(() => vi.restoreAllMocks());

test("uses the reachable LAN origin with verified public-host TLS and a signed Access assertion", async () => {
	const fetcher = spyOn(globalThis, "fetch")
		.mockResolvedValueOnce(new Response(null, { status: 403 }))
		.mockResolvedValueOnce(
			new Response(null, {
				status: 400,
				headers: { "set-cookie": "CF_Authorization=eyJ.eyJ.c2ln; Secure; HttpOnly" },
			}),
		);
	const endpoint = await selectBridgeEndpoint(url, headers, origin);
	expect(endpoint.url).toBe("wss://10.0.0.13:44301/ws/bridge");
	expect(endpoint.tls).toEqual({ serverName: "sessions.the-freed.family", rejectUnauthorized: true });
	expect(endpoint.headers).toEqual({
		host: "sessions.the-freed.family",
		Authorization: "Bearer fixture",
		"cf-access-jwt-assertion": "eyJ.eyJ.c2ln",
	});
	const [probeUrl, probe] = fetcher.mock.calls[0]!;
	expect(String(probeUrl)).toBe("https://10.0.0.13:44301/ws/bridge");
	expect(probe).toMatchObject({ tls: endpoint.tls });
	expect(probe?.signal).toBeInstanceOf(AbortSignal);
	expect(fetcher.mock.calls[1]?.[1]?.headers).toBe(headers);
});

test("falls back to the public endpoint when the LAN probe times out", async () => {
	spyOn(globalThis, "fetch").mockRejectedValueOnce(new DOMException("timeout", "TimeoutError"));
	expect(await selectBridgeEndpoint(url, headers, origin)).toEqual({ url, headers });
});

test("rechecks the LAN origin on reconnect and rejects TLS or authentication failures", async () => {
	spyOn(globalThis, "fetch")
		.mockRejectedValueOnce(new Error("certificate mismatch"))
		.mockResolvedValueOnce(new Response(null, { status: 403 }))
		.mockResolvedValueOnce(new Response(null, { status: 403 }));
	expect(await selectBridgeEndpoint(url, headers, origin)).toEqual({ url, headers });
	expect(await selectBridgeEndpoint(url, headers, origin)).toEqual({ url, headers });
});
