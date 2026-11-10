import type { Signer } from "near-api-js";

/** Public URL of Inti's agent API (INTI_API_URL in the root .env). Not a secret. */
const API_URL = (import.meta.env as Record<string, string | undefined>).INTI_API_URL;

const MESSAGES: Record<string, string> = {
  unauthorized: "Your session expired. Sign in again and retry.",
  no_agent: "Create your agent first.",
  rate_limited: "Too many tries today. Try again tomorrow.",
  agents_unavailable: "I couldn't reach NEAR Intents right now. Try again in a minute.",
};
const GENERIC = "Inti could not be allowed to trade. Nothing was signed. Try again in a minute.";

export class GrantError extends Error {}

/** Until when Inti may trade for the user's agent (ISO date), or null when it may not. */
export type GrantState = { status: "none" } | { status: "active"; agentAccount: string; grant: { expiresAt: string } | null };

async function call(path: string, accessToken: string, body?: unknown): Promise<Record<string, unknown>> {
  if (!API_URL) throw new GrantError("Inti's server is not configured yet.");
  let res: Response;
  try {
    res = await fetch(new URL(path, API_URL), {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${accessToken}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw new GrantError("I couldn't reach Inti's server. Check your connection and retry.");
  }
  const answer = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof answer.status !== "string") throw new GrantError(MESSAGES[String(answer.error ?? "")] ?? GENERIC);
  return answer;
}

/** The user's agent and its grant, as Inti's server knows them. */
export async function grantState(accessToken: string): Promise<GrantState> {
  const answer = await call("/api/agent", accessToken);
  if (answer.status !== "active") return { status: "none" };
  const grant = answer.grant as { expiresAt?: unknown } | null | undefined;
  return {
    status: "active",
    agentAccount: String(answer.agentAccount),
    grant: grant && typeof grant.expiresAt === "string" ? { expiresAt: grant.expiresAt } : null,
  };
}

function base64(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

/**
 * Lets Inti's server trade for the user's agent: the server makes the grant, the owner signer
 * checks it and shows it in plain words, and the user's key signs it. Returns until when it lasts.
 */
export async function issueGrant({ accessToken, accountId, signer }: { accessToken: string; accountId: string; signer: Signer }): Promise<string> {
  const prepared = await call("/api/agent/grant/prepare", accessToken, {});
  const intent = prepared.intent as { standard?: unknown; payload?: { message?: unknown; recipient?: unknown; nonce?: unknown } } | undefined;
  const payload = intent?.payload;
  if (
    prepared.status !== "pending_signature" ||
    typeof prepared.correlationId !== "string" ||
    intent?.standard !== "nep413" ||
    typeof payload?.message !== "string" ||
    typeof payload.recipient !== "string" ||
    typeof payload.nonce !== "string"
  ) {
    throw new GrantError(GENERIC);
  }
  const nonce = fromBase64(payload.nonce);
  if (nonce.length !== 32) throw new GrantError(GENERIC);

  // The owner signer refuses anything that is not a grant for this account, before the wallet sees it.
  const signed = await signer.signNep413Message(accountId, { message: payload.message, recipient: payload.recipient, nonce });
  const sent = await call("/api/agent/grant/submit", accessToken, {
    correlationId: prepared.correlationId,
    signedData: { ...intent, public_key: signed.publicKey.toString(), signature: base64(signed.signature) },
  });
  if (sent.status === "success" && typeof sent.expiresAt === "string") return sent.expiresAt;
  if (sent.status === "processing") throw new GrantError("Almost there: Inti's permission is still being saved. Check again in a minute.");
  throw new GrantError(GENERIC);
}
