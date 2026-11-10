import { Account, actions, encodeSignedDelegate } from "near-api-js";
import type { JsonRpcProvider, Signer } from "near-api-js";
import { agentPolicy } from "../../../agent/policy/agentPolicy";
import { policyDifferences } from "../../../agent/policy/verify";
import type { LimitsConfig } from "../limits/config";
import { agentAccountOf } from "../limits/ownerActions";

/** Public URL of Inti's agent API (INTI_API_URL in the root .env). Not a secret. */
const API_URL = (import.meta.env as Record<string, string | undefined>).INTI_API_URL;

/** Blocks the signed creation stays valid for; the Agent API accepts it for about ten minutes. */
const SIGNATURE_TTL_BLOCKS = 600;
/** How long the app waits for the Agent API to finish creating the agent. */
const SETTLE_ATTEMPTS = 12;
const SETTLE_WAIT_MS = 5000;

const MESSAGES: Record<string, string> = {
  unauthorized: "Your session expired. Sign in again and retry.",
  agents_limit: "Inti reached today's limit of new agents. Try again tomorrow.",
  agents_unavailable: "I couldn't reach NEAR Intents right now. Try again in a minute.",
  rate_limited: "Too many requests in a minute. Wait a moment and retry.",
};
const GENERIC = "Your agent could not be created. Nothing was charged. Try again in a minute.";

export class AgentSetupError extends Error {}

type AgentAnswer =
  | { status: "none" }
  | { status: "active"; agentAccount: string; ownerAccount: string }
  | { status: "pending_signature"; correlationId: string; intent: unknown; preview: { policy: unknown } }
  | { status: "success" | "processing" | "failed" };

async function call(path: string, accessToken: string, body?: unknown): Promise<AgentAnswer> {
  if (!API_URL) throw new AgentSetupError("Inti's server is not configured yet.");
  let res: Response;
  try {
    res = await fetch(new URL(path, API_URL), {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${accessToken}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw new AgentSetupError("I couldn't reach Inti's server. Check your connection and retry.");
  }
  const answer = (await res.json().catch(() => ({}))) as { error?: string; status?: string };
  if (!res.ok || typeof answer.status !== "string") throw new AgentSetupError(MESSAGES[answer.error ?? ""] ?? GENERIC);
  return answer as AgentAnswer;
}

/** The agent Inti's server knows for this user, or null. Only an agent owned by this account counts. */
export async function findAgent(accessToken: string, accountId: string): Promise<string | null> {
  const answer = await call("/api/agent", accessToken);
  return answer.status === "active" && answer.ownerAccount === accountId ? answer.agentAccount : null;
}

interface CreationPayload {
  receiverId: string;
  actions: { type: "FunctionCall"; params: { methodName: string; args: Record<string, unknown>; gas: string; deposit: string } }[];
}

/** The creation request as the Agent API sent it, or an error when it is not the documented shape. */
function creationPayload(intent: unknown): CreationPayload {
  const { standard, payload } = (intent ?? {}) as { standard?: unknown; payload?: Partial<CreationPayload> };
  const valid =
    standard === "nep366" &&
    typeof payload?.receiverId === "string" &&
    Array.isArray(payload.actions) &&
    payload.actions.every(
      (a) =>
        a.type === "FunctionCall" &&
        typeof a.params.methodName === "string" &&
        typeof a.params.args === "object" &&
        a.params.args !== null &&
        /^\d+$/.test(a.params.gas) &&
        /^\d+$/.test(a.params.deposit),
    );
  if (!valid) throw new AgentSetupError(GENERIC);
  return payload as CreationPayload;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function base64(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

interface CreateAgentArgs {
  accessToken: string;
  /** The user's own NEAR account: it owns the agent. */
  accountId: string;
  config: LimitsConfig;
  provider: JsonRpcProvider;
  /** The owner signer: it shows the request to the user and signs only if they confirm. */
  signer: Signer;
}

/**
 * Creates the user's own agent on NEAR Intents and returns its account. The rules the Agent API
 * says it will store must be exactly the ones Inti built, and the agent account is read from the
 * request the user signs, so neither can be swapped on the way.
 */
export async function createAgent({ accessToken, accountId, config, provider, signer }: CreateAgentArgs): Promise<string> {
  const publicKey = (await signer.getPublicKey()).toString();
  const prepared = await call("/api/agent/prepare", accessToken, { accountId, publicKey });
  if (prepared.status === "active") {
    if (prepared.ownerAccount !== accountId) throw new AgentSetupError(GENERIC);
    return prepared.agentAccount;
  }
  if (prepared.status !== "pending_signature") throw new AgentSetupError(GENERIC);
  if (policyDifferences(agentPolicy(accountId), prepared.preview.policy).length > 0) {
    throw new AgentSetupError("The agent's rules are not the ones Inti expected, so nothing was signed.");
  }

  const payload = creationPayload(prepared.intent);
  const { signedDelegate } = await new Account(accountId, provider, signer).createSignedMetaTransaction({
    receiverId: payload.receiverId,
    actions: payload.actions.map((a) => actions.functionCall(a.params.methodName, a.params.args, BigInt(a.params.gas), BigInt(a.params.deposit))),
    blockHeightTtl: SIGNATURE_TTL_BLOCKS,
  });
  const agentAccount = agentAccountOf(signedDelegate.delegateAction, config);

  const sent = await call("/api/agent/submit", accessToken, {
    correlationId: prepared.correlationId,
    signedData: { ...(prepared.intent as object), signed_delegate: base64(encodeSignedDelegate(signedDelegate)) },
  });
  if (sent.status === "success") return agentAccount;
  if (sent.status !== "processing") throw new AgentSetupError(GENERIC);
  for (let attempt = 0; attempt < SETTLE_ATTEMPTS; attempt++) {
    await wait(SETTLE_WAIT_MS);
    if ((await findAgent(accessToken, accountId)) === agentAccount) return agentAccount;
  }
  throw new AgentSetupError("Your agent is still being created. Come back in a few minutes.");
}
