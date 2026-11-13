import { Account, actions, encodeSignedDelegate } from "near-api-js";
import type { JsonRpcProvider, Signer } from "near-api-js";
import { agentPolicy, PRICE_PROTECTION_BPS, type PriceProtectionBps } from "../../../agent/policy/agentPolicy";
import { policyDifferences } from "../../../agent/policy/verify";
import type { LimitsConfig } from "../limits/config";
import { agentFreezeOf } from "../limits/ownerActions";

/** Public URL of Inti's agent API (INTI_API_URL in the root .env). Not a secret. */
const API_URL = (import.meta.env as Record<string, string | undefined>).INTI_API_URL;

/** Blocks the signed freeze stays valid for, as for creating the agent. */
const SIGNATURE_TTL_BLOCKS = 600;

const MESSAGES: Record<string, string> = {
  unauthorized: "Your session expired. Sign in again and retry.",
  no_agent: "Create your agent first.",
  rate_limited: "Too many changes today. Try again tomorrow.",
  agents_unavailable: "I couldn't reach NEAR Intents right now. Try again in a minute.",
};
const GENERIC = "Your agent could not be frozen. Nothing was signed. Try again in a minute.";

export class FreezeError extends Error {}

async function call(path: string, accessToken: string, body: unknown): Promise<Record<string, unknown>> {
  if (!API_URL) throw new FreezeError("Inti's server is not configured yet.");
  let res: Response;
  try {
    res = await fetch(new URL(path, API_URL), {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw new FreezeError("I couldn't reach Inti's server. Check your connection and retry.");
  }
  const answer = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof answer.status !== "string") throw new FreezeError(MESSAGES[String(answer.error ?? "")] ?? GENERIC);
  return answer;
}

interface FreezePayload {
  receiverId: string;
  actions: { type: "FunctionCall"; params: { methodName: string; args: Record<string, unknown>; gas: string; deposit: string } }[];
}

/** The freeze request as the Agent API sent it, or an error when it is not the documented shape. */
function freezePayload(intent: unknown): FreezePayload {
  const { standard, payload } = (intent ?? {}) as { standard?: unknown; payload?: Partial<FreezePayload> };
  const valid =
    standard === "nep366" &&
    typeof payload?.receiverId === "string" &&
    Array.isArray(payload.actions) &&
    payload.actions.every(
      (a) => a.type === "FunctionCall" && typeof a.params.methodName === "string" && typeof a.params.args === "object" && a.params.args !== null && /^\d+$/.test(a.params.gas) && /^\d+$/.test(a.params.deposit),
    );
  if (!valid) throw new FreezeError(GENERIC);
  return payload as FreezePayload;
}

function base64(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

interface FreezeArgs {
  accessToken: string;
  /** The user's own NEAR account: it owns the agent. */
  accountId: string;
  /** The user's agent account, as the dashboard knows it. The freeze must be for this one. */
  agentAccount: string;
  /** The price protection the user signed: the rules stored with the freeze must keep it. */
  maxDeviationBps: number;
  config: LimitsConfig;
  provider: JsonRpcProvider;
  /** The owner signer: it shows the request to the user and signs only if they confirm. */
  signer: Signer;
}

/**
 * Freezes the user's agent: every action of it fails until the owner unfreezes it. The rules
 * stored with the freeze are encrypted, so before signing the app checks that the Agent API's
 * preview of them is exactly the user's own rules marked frozen, and that the request is for the
 * user's own agent. "already" means it was frozen before.
 */
export async function freezeAgent({ accessToken, accountId, agentAccount, maxDeviationBps, config, provider, signer }: FreezeArgs): Promise<"frozen" | "already" | "processing"> {
  if (!PRICE_PROTECTION_BPS.includes(maxDeviationBps as PriceProtectionBps)) throw new FreezeError(GENERIC);
  const prepared = await call("/api/agent/freeze/prepare", accessToken, {});
  if (prepared.status === "already_frozen") return "already";
  if (prepared.status !== "pending_signature" || typeof prepared.correlationId !== "string") throw new FreezeError(GENERIC);
  const preview = (prepared.preview ?? {}) as { policy?: unknown };
  const expected = { ...agentPolicy(accountId, maxDeviationBps as PriceProtectionBps), frozen: true };
  if (policyDifferences(expected, preview.policy).length > 0) throw new FreezeError("The agent's rules are not the ones Inti expected, so nothing was signed.");

  const payload = freezePayload(prepared.intent);
  const { signedDelegate } = await new Account(accountId, provider, signer).createSignedMetaTransaction({
    receiverId: payload.receiverId,
    actions: payload.actions.map((a) => actions.functionCall(a.params.methodName, a.params.args, BigInt(a.params.gas), BigInt(a.params.deposit))),
    blockHeightTtl: SIGNATURE_TTL_BLOCKS,
  });
  if (agentFreezeOf(signedDelegate.delegateAction, config) !== agentAccount) throw new FreezeError("The freeze is not for your agent, so it was not sent.");

  const sent = await call("/api/agent/freeze/submit", accessToken, {
    correlationId: prepared.correlationId,
    signedData: { ...(prepared.intent as object), signed_delegate: base64(encodeSignedDelegate(signedDelegate)) },
  });
  if (sent.status === "success") return "frozen";
  if (sent.status === "processing") return "processing";
  throw new FreezeError(GENERIC);
}
