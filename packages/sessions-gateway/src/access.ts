import { createRemoteJWKSet, jwtVerify } from "jose";

export const ACCESS_ISSUER = "https://freedfamily.cloudflareaccess.com";
export const ACCESS_AUDIENCE = "994fba830dba4a37bbd29191c62dfff5f4a63d399bb51ac0c404e7f04f66ae57";

export type AccessPrincipal = "user" | "service";

export function createAccessVerifier(
	certsUrl = new URL(`${ACCESS_ISSUER}/cdn-cgi/access/certs`),
): (request: Request) => Promise<AccessPrincipal | undefined> {
	const keys = createRemoteJWKSet(certsUrl, { cacheMaxAge: 5 * 60_000, cooldownDuration: 0, timeoutDuration: 5_000 });
	return async request => {
		const assertion = request.headers.get("cf-access-jwt-assertion");
		if (!assertion) return undefined;
		try {
			const { payload } = await jwtVerify(assertion, keys, {
				algorithms: ["RS256"],
				issuer: ACCESS_ISSUER,
				audience: ACCESS_AUDIENCE,
				requiredClaims: ["exp"],
			});
			if (typeof payload.email === "string" && payload.email.length > 0) return "user";
			if (payload.email === undefined && typeof payload.common_name === "string" && payload.common_name.length > 0)
				return "service";
			return undefined;
		} catch {
			return undefined;
		}
	};
}
