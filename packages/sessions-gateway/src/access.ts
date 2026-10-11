import { createRemoteJWKSet, jwtVerify } from "jose";

export const ACCESS_ISSUER = "https://freedfamily.cloudflareaccess.com";
export const ACCESS_AUDIENCE = "994fba830dba4a37bbd29191c62dfff5f4a63d399bb51ac0c404e7f04f66ae57";

export function createAccessVerifier(
	certsUrl = new URL(`${ACCESS_ISSUER}/cdn-cgi/access/certs`),
): (request: Request) => Promise<boolean> {
	const keys = createRemoteJWKSet(certsUrl, { cacheMaxAge: 5 * 60_000, cooldownDuration: 0, timeoutDuration: 5_000 });
	return async request => {
		const assertion = request.headers.get("cf-access-jwt-assertion");
		if (!assertion) return false;
		try {
			await jwtVerify(assertion, keys, {
				algorithms: ["RS256"],
				issuer: ACCESS_ISSUER,
				audience: ACCESS_AUDIENCE,
				requiredClaims: ["exp"],
			});
			return true;
		} catch {
			return false;
		}
	};
}
