import type { Signer } from "near-api-js";
import type { PriceProtectionBps } from "../../../agent/policy/agentPolicy";

/** Public URL of Inti's agent API (INTI_API_URL in the root .env). Not a secret. */
const API_URL = (import.meta.env as Record<string, string | undefined>).INTI_API_URL;

const MESSAGES: Record<string, string> = {
  unauthorized: "Your session expired. Sign in again and retry.",
  no_agent: "Create your agent first.",
  rate_limited: "Too many changes today. Try again tomorrow.",
  agents_unavailable: "I couldn't reach NEAR Intents right now. Try again in a minute.",
};
const GENERIC = "Your price protection could not be changed. Nothing was signed. Try again in a minute.";

export class PriceProtectionError extends Error {}

async function call(path: string, accessToken: string, body: unknown): Promise<Record<string, unknown>> {
  if (!API_URL) throw new PriceProtectionError("Inti's server is not configured yet.");
  let res: Response;
  try {
    res = await fetch(new URL(path, API_URL), {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw new PriceProtectionError("I couldn't reach Inti's server. Check your connection and retry.");
  }
  const answer = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (answer.error === "cooldown" && typeof answer.availableAt === "string") {
    const at = new Date(answer.availableAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    throw new PriceProtectionError(`NEAR Intents waits a few minutes between rule changes. Try again after ${at}.`);
  }
  if (!res.ok || typeof answer.status !== "string") throw new PriceProtectionError(MESSAGES[String(answer.error ?? "")] ?? GENERIC);
  return answer;
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
 * Sets the price protection of the user's agent. Inti's server asks NEAR Intents for the change,
 * the owner signer checks that only the price protection differs from Inti's rules and shows it in
 * plain words, and the user's key signs it.
 */
export async function setPriceProtection({ accessToken, accountId, signer, bps }: { accessToken: string; accountId: string; signer: Signer; bps: PriceProtectionBps }): Promise<void> {
  const prepared = await call("/api/agent/policy/prepare", accessToken, { maxDeviationBps: bps });
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
    throw new PriceProtectionError(GENERIC);
  }
  const nonce = fromBase64(payload.nonce);
  if (nonce.length !== 32) throw new PriceProtectionError(GENERIC);

  const signed = await signer.signNep413Message(accountId, { message: payload.message, recipient: payload.recipient, nonce });
  const sent = await call("/api/agent/policy/submit", accessToken, {
    correlationId: prepared.correlationId,
    signedData: { ...intent, public_key: signed.publicKey.toString(), signature: base64(signed.signature) },
  });
  if (sent.status === "success") return;
  if (sent.status === "processing") throw new PriceProtectionError("Almost there: your new price protection is still being saved. Check again in a minute.");
  throw new PriceProtectionError(GENERIC);
}
