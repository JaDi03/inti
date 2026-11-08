import { importSPKI, jwtVerify } from "jose";

/** Returns the Privy user id (did:privy:...) of a valid access token, or throws. */
export type TokenVerifier = (token: string) => Promise<string>;

/**
 * Verifies Privy access tokens locally, as Privy documents with `jose`
 * (docs.privy.io/authentication/user-authentication/access-tokens): ES256 only,
 * issuer "privy.io", audience = our app id, and jose checks exp/nbf.
 * Only the public verification key is needed, never the Privy app secret.
 */
export async function privyVerifier(appId: string, verificationKeyPem: string): Promise<TokenVerifier> {
  const key = await importSPKI(verificationKeyPem, "ES256");
  return async (token) => {
    const { payload } = await jwtVerify(token, key, { algorithms: ["ES256"], issuer: "privy.io", audience: appId });
    if (typeof payload.sub !== "string" || !payload.sub.startsWith("did:privy:")) throw new Error("unexpected subject");
    return payload.sub;
  };
}

/** Bearer token from the Authorization header; the whole header must match. */
export function bearerToken(header: string | undefined): string | null {
  const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(header ?? "");
  return match?.[1] ?? null;
}
