import type { OwnerSigner } from "../limits/ownerSigner";

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

/** How long the user may let Inti trade before signing again. */
export const GRANT_DAY_CHOICES = [7, 30, 90] as const;
export type GrantDays = (typeof GRANT_DAY_CHOICES)[number];

interface OwnerMessage {
  correlationId: string;
  intent: { standard: "nep413"; payload: { message: string; recipient: string; nonce: string } };
  nonce: Uint8Array;
}

/** A message the Agent API built for the owner to sign, or null when it is not the documented shape. */
function ownerMessage(correlationId: unknown, rawIntent: unknown): OwnerMessage | null {
  const intent = rawIntent as { standard?: unknown; payload?: { message?: unknown; recipient?: unknown; nonce?: unknown } } | undefined;
  const payload = intent?.payload;
  if (
    typeof correlationId !== "string" ||
    intent?.standard !== "nep413" ||
    typeof payload?.message !== "string" ||
    typeof payload.recipient !== "string" ||
    typeof payload.nonce !== "string"
  ) {
    return null;
  }
  const nonce = fromBase64(payload.nonce);
  if (nonce.length !== 32) return null;
  return { correlationId, intent: intent as OwnerMessage["intent"], nonce };
}

async function signAndSend(path: string, accessToken: string, accountId: string, signer: OwnerSigner, m: OwnerMessage): Promise<Record<string, unknown>> {
  const { message, recipient } = m.intent.payload;
  const signed = await signer.signNep413Message(accountId, { message, recipient, nonce: m.nonce });
  return call(path, accessToken, {
    correlationId: m.correlationId,
    signedData: { ...m.intent, public_key: signed.publicKey.toString(), signature: base64(signed.signature) },
  });
}

/**
 * Lets Inti's server trade for the user's agent for `days`: the server makes the grant, the owner
 * signer checks it and shows it in plain words, and the user's key signs it. Inti's earlier grants
 * are closed in the same confirmation, but only after the new one is live, so trading never stops.
 * Returns until when the new grant lasts.
 */
export async function issueGrant({ accessToken, accountId, signer, days }: { accessToken: string; accountId: string; signer: OwnerSigner; days?: GrantDays }): Promise<string> {
  const prepared = await call("/api/agent/grant/prepare", accessToken, days === undefined ? {} : { days });
  const grant = prepared.status === "pending_signature" ? ownerMessage(prepared.correlationId, prepared.intent) : null;
  if (!grant) throw new GrantError(GENERIC);
  const revokes = (Array.isArray(prepared.revokes) ? prepared.revokes : []).map((r: { correlationId?: unknown; intent?: unknown }) => ownerMessage(r.correlationId, r.intent));
  if (revokes.some((r) => r === null)) throw new GrantError(GENERIC);
  const closings = revokes as OwnerMessage[];

  // The owner signer refuses anything that is not a grant or a closing for this account, before the wallet sees it.
  await signer.approveMessages(
    accountId,
    [grant, ...closings].map((m) => ({ message: m.intent.payload.message, recipient: m.intent.payload.recipient, nonce: m.nonce })),
  );
  const sent = await signAndSend("/api/agent/grant/submit", accessToken, accountId, signer, grant);
  if (sent.status === "processing") throw new GrantError("Almost there: Inti's permission is still being saved. Check again in a minute.");
  if (sent.status !== "success" || typeof sent.expiresAt !== "string") throw new GrantError(GENERIC);
  // The new grant is live. A closing that fails leaves an earlier grant open until it expires; the
  // next renewal closes it, since the server lists every earlier grant that is still live.
  for (const closing of closings) await signAndSend("/api/agent/grant/revoke/submit", accessToken, accountId, signer, closing).catch(() => null);
  return sent.expiresAt;
}
