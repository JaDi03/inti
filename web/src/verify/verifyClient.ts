/** Public URL of Inti's agent API (INTI_API_URL in the root .env). Not a secret. */
const API_URL = (import.meta.env as Record<string, string | undefined>).INTI_API_URL;

export type CheckId = "report" | "nonce" | "intel" | "not_debug" | "binds_nonce" | "binds_key" | "software" | "config" | "gpu";

/** One fresh check of the hardware the chat's model runs on, as Inti's server reports it. */
export interface ModelVerification {
  model: string;
  ok: boolean;
  checks: { id: CheckId; ok: boolean }[];
  signingAddress: string | null;
  intelStatus: string | null;
  checkedAt: string;
}

/** What each check proves, in plain words. */
export const CHECK_TEXT: Record<CheckId, string> = {
  report: "NEAR AI answered for Inti's model",
  nonce: "It answered the new challenge Inti sent",
  intel: "Genuine Intel TDX chip, rated up to date by Intel",
  not_debug: "The chip is sealed, not in debug mode",
  binds_nonce: "The chip itself signed that challenge",
  binds_key: "The chip holds the model's signing key (shared by the model's machines)",
  software: "Its startup log matches what the chip measured",
  config: "Its published setup matches what the chip measured",
  gpu: "Genuine NVIDIA GPU, confirmed by NVIDIA for that challenge",
};

const MESSAGES: Record<string, string> = {
  user_limit: "You reached today's limit of checks. Try again tomorrow.",
  server_limit: "Too many checks today. Try again tomorrow.",
  busy: "Other checks are running. Try again in a moment.",
  rate_limited: "Too many requests in a minute. Wait a moment and retry.",
};

export type CallFailure = "unavailable" | "not_model" | "other_bytes" | "other_signer" | "not_attested";

/** Whether every model call behind one reply was signed by the key found in the attested chip. */
export interface ReplyProof {
  ok: boolean;
  calls: { responseId: string; ok: boolean; failure: CallFailure | null }[];
  attestedKey: string | null;
  checkedAt: string;
}

/** Why a reply is not proven, in plain words. */
export const FAILURE_TEXT: Record<CallFailure, string> = {
  unavailable: "NEAR AI has no signature for it yet",
  not_model: "it was signed by NEAR AI's gateway, not by the model",
  other_bytes: "the signature covers other words than the ones Inti got",
  other_signer: "the signature does not match its signer",
  not_attested: "the signer is not the key found in the verified chip",
};

/** Asks Inti's server to check the signatures behind one of the user's replies. */
export async function fetchReplyProof(accessToken: string, proofId: string): Promise<ReplyProof> {
  if (!API_URL) throw new Error("Inti's server is not configured yet.");
  let res: Response;
  try {
    res = await fetch(new URL(`/api/chat/proof/${encodeURIComponent(proofId)}`, API_URL), { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(60_000) });
  } catch {
    throw new Error("The check could not reach Inti's server.");
  }
  const body = (await res.json().catch(() => ({}))) as Partial<ReplyProof> & { error?: string };
  if (!res.ok || !Array.isArray(body.calls)) throw new Error(MESSAGES[body.error ?? ""] ?? "The check could not run right now.");
  return body as ReplyProof;
}

/**
 * Asks Inti's server for the check: the recent one everyone shares, or with `fresh` a new one that
 * counts against the user's daily checks. Throws a short sentence the user understands.
 */
export async function fetchVerification(accessToken: string, fresh = false): Promise<ModelVerification> {
  if (!API_URL) throw new Error("Inti's server is not configured yet.");
  let res: Response;
  try {
    const url = new URL("/api/verify", API_URL);
    if (fresh) url.searchParams.set("fresh", "true");
    res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(60_000) });
  } catch {
    throw new Error("The check could not reach Inti's server. Try again in a minute.");
  }
  const body = (await res.json().catch(() => ({}))) as Partial<ModelVerification> & { error?: string };
  if (!res.ok || !Array.isArray(body.checks)) throw new Error(MESSAGES[body.error ?? ""] ?? "The check could not run right now. Try again in a minute.");
  return body as ModelVerification;
}
