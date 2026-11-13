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
const GENERIC = "Your agent's state could not be changed. Nothing was signed. Try again in a minute.";

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

/**
 * Whether the rules a freeze would store are the user's own rules marked frozen. Everything must
 * match Inti's rules except the list of destinations, which may still hold entries from when the
 * agent was created; every one of those must send only to the owner's own account. So a freeze can
 * never open a new place for money to go.
 */
export function frozenRulesAreSafe(policy: unknown, owner: string, maxDeviationBps: PriceProtectionBps, frozen = true): boolean {
  const expected = { ...agentPolicy(owner, maxDeviationBps), frozen };
  if (typeof policy !== "object" || policy === null) return false;
  const { destinations, ...rest } = policy as { destinations?: unknown };
  const expectedRest = Object.fromEntries(Object.entries(expected).filter(([k]) => k !== "destinations"));
  if (policyDifferences(expectedRest, rest).length > 0) return false;
  const d = destinations as { mode?: unknown; list?: unknown } | undefined;
  if (d?.mode !== "only" || !Array.isArray(d.list) || d.list.length === 0 || Object.keys(d).length !== 2) return false;
  return d.list.every((entry: unknown) => {
    const e = entry as Record<string, unknown>;
    if (e.address !== owner) return false;
    if (e.action === "transfer") return Object.keys(e).length === 3 && typeof e.confidential === "boolean";
    return e.action === "withdraw" && e.chain === "near" && e.memo === null && Object.keys(e).length === 4;
  });
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
 * Freezes the user's agent (`frozen` true: every action of it fails until the owner unfreezes it)
 * or unfreezes it. The rules stored with either are encrypted, so before signing the app checks
 * that the Agent API's preview of them is the user's own rules, frozen or not as asked, and that
 * the request is that very change for the user's own agent. "already" means nothing had to change.
 */
export async function setAgentFrozen({ accessToken, accountId, agentAccount, maxDeviationBps, config, provider, signer, frozen }: FreezeArgs & { frozen: boolean }): Promise<"done" | "already" | "processing"> {
  if (!PRICE_PROTECTION_BPS.includes(maxDeviationBps as PriceProtectionBps)) throw new FreezeError(GENERIC);
  const prepared = await call("/api/agent/freeze/prepare", accessToken, { frozen });
  if (prepared.status === (frozen ? "already_frozen" : "already_unfrozen")) return "already";
  if (prepared.status !== "pending_signature" || typeof prepared.correlationId !== "string") throw new FreezeError(GENERIC);
  const preview = (prepared.preview ?? {}) as { policy?: unknown };
  if (!frozenRulesAreSafe(preview.policy, accountId, maxDeviationBps as PriceProtectionBps, frozen)) {
    throw new FreezeError("The agent's rules are not the ones Inti expected, so nothing was signed.");
  }

  const payload = freezePayload(prepared.intent);
  const { signedDelegate } = await new Account(accountId, provider, signer).createSignedMetaTransaction({
    receiverId: payload.receiverId,
    actions: payload.actions.map((a) => actions.functionCall(a.params.methodName, a.params.args, BigInt(a.params.gas), BigInt(a.params.deposit))),
    blockHeightTtl: SIGNATURE_TTL_BLOCKS,
  });
  const signedFor = agentFreezeOf(signedDelegate.delegateAction, config);
  if (signedFor.agentAccount !== agentAccount || signedFor.frozen !== frozen) throw new FreezeError("The request is not the change you asked for on your agent, so it was not sent.");

  const sent = await call("/api/agent/freeze/submit", accessToken, {
    correlationId: prepared.correlationId,
    signedData: { ...(prepared.intent as object), signed_delegate: base64(encodeSignedDelegate(signedDelegate)) },
  });
  if (sent.status === "success") return "done";
  if (sent.status === "processing") return "processing";
  throw new FreezeError(GENERIC);
}
