import { logger } from "@oh-my-pi/pi-utils";
import { sanitizeDiagnostic } from "../../sessions-gateway/src/protocol";

export interface BridgeEndpoint {
	url: string;
	headers: Record<string, string>;
	tls?: Bun.TLSOptions;
}

export async function selectBridgeEndpoint(
	url: string,
	headers: Record<string, string>,
	origin?: string,
): Promise<BridgeEndpoint> {
	const fallback = { url, headers };
	if (!origin) return fallback;
	const publicUrl = new URL(url);
	const local = new URL(origin);
	if (
		local.protocol !== "https:" ||
		local.username ||
		local.password ||
		local.pathname !== "/" ||
		local.search ||
		local.hash
	)
		throw new Error("The bridge LAN origin requires an HTTPS origin");
	local.pathname = publicUrl.pathname;
	const tls = { serverName: publicUrl.hostname, rejectUnauthorized: true };
	try {
		const probe = await fetch(local.href, {
			headers: { host: publicUrl.hostname },
			tls,
			redirect: "manual",
			signal: AbortSignal.timeout(1_000),
		});
		await probe.body?.cancel();
		if (probe.status !== 403) throw new Error("Unexpected LAN gateway probe response");
		// Access signs the service assertion at the edge; the LAN gateway verifies it unchanged.
		const assertionUrl = new URL(url);
		const response = await fetch(assertionUrl, {
			headers,
			redirect: "manual",
			signal: AbortSignal.timeout(5_000),
		});
		await response.body?.cancel();
		const assertion = response.headers
			.getSetCookie()
			.map(cookie => /^CF_Authorization=([^;]+)/.exec(cookie)?.[1])
			.find(Boolean);
		if (!assertion || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(assertion))
			throw new Error("Cloudflare did not return a service assertion");
		return {
			url: local.href,
			headers: {
				host: publicUrl.hostname,
				Authorization: new Headers(headers).get("authorization") ?? "",
				"cf-access-jwt-assertion": assertion,
			},
			tls,
		};
	} catch (cause) {
		logger.info("Sessions LAN origin unavailable; using public gateway", { cause: sanitizeDiagnostic(cause) });
		return fallback;
	}
}
