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
  nonce: "It answered the fresh challenge Inti just sent",
  intel: "Genuine Intel TDX chip, rated up to date by Intel",
  not_debug: "The chip is sealed, not in debug mode",
  binds_nonce: "The chip itself signed that challenge",
  binds_key: "The chip holds the key the model signs replies with",
  software: "It runs the software it measured at start",
  config: "Its configuration matches what it published",
  gpu: "Genuine NVIDIA GPU, confirmed by NVIDIA",
};

const MESSAGES: Record<string, string> = {
  user_limit: "You reached today's limit of checks. Try again tomorrow.",
  server_limit: "Too many checks today. Try again tomorrow.",
  busy: "Other checks are running. Try again in a moment.",
  rate_limited: "Too many requests in a minute. Wait a moment and retry.",
};

/** Asks Inti's server for a fresh check; throws a short sentence the user understands. */
export async function fetchVerification(accessToken: string): Promise<ModelVerification> {
  if (!API_URL) throw new Error("Inti's server is not configured yet.");
  let res: Response;
  try {
    res = await fetch(new URL("/api/verify", API_URL), { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(60_000) });
  } catch {
    throw new Error("The check could not reach Inti's server. Try again in a minute.");
  }
  const body = (await res.json().catch(() => ({}))) as Partial<ModelVerification> & { error?: string };
  if (!res.ok || !Array.isArray(body.checks)) throw new Error(MESSAGES[body.error ?? ""] ?? "The check could not run right now. Try again in a minute.");
  return body as ModelVerification;
}
