import type { AgentView, StatusResponse } from "@near-intents-agent-api/sdk";
import { agentPolicy } from "../policy/agentPolicy.js";

/** The owner of an agent: the user's own NEAR account and its full-access key. */
export interface AgentOwner {
  accountId: string;
  publicKey: string;
}

export type AgentLookup = { status: "none" } | { status: "active"; agentId: string; agentAccount: string; ownerAccount: string };

/** What the owner's wallet must sign to create the agent, as the Agent API returned it. */
export interface PreparedAgent {
  correlationId: string;
  intent: unknown;
  preview: { summary: string; policy: unknown };
}

export type AgentOutcome = "success" | "processing" | "failed";

export class AgentsUnavailableError extends Error {
  constructor(readonly code: "agents_limit" | "agents_unavailable") {
    super(code);
  }
}

/** One agent per user on the NEAR Intents Agent API. */
export interface AgentAccounts {
  find(userId: string): Promise<AgentLookup>;
  prepare(userId: string, owner: AgentOwner): Promise<PreparedAgent>;
  submit(correlationId: string, signedData: unknown, type?: OwnerIntentType): Promise<AgentOutcome>;
  /** Asks for the document the owner signs to let Inti's server act for their agent. */
  prepareGrant(body: Record<string, string>): Promise<{ correlationId: string; intent: unknown; preview: { summary: string } }>;
}

/** The owner-signed actions Inti sends. */
export type OwnerIntentType = "agent_create" | "grant_issue";

/** Longest the server waits for one Agent API answer; a status read may hold for 30 s by design. */
const REQUEST_TIMEOUT_MS = 45_000;
const STATUS_WAIT_MS = 30_000;

/** An Agent API answer that was not a success, by HTTP status. */
class UpstreamError extends Error {
  constructor(readonly status: number) {
    super(`agent api answered ${status}`);
  }
}

/** The Agent API refuses new agents past its daily quota; every other failure is an outage to the user. */
function unavailable(error: unknown): AgentsUnavailableError {
  const limited = error instanceof UpstreamError && error.status === 429;
  return new AgentsUnavailableError(limited ? "agents_limit" : "agents_unavailable");
}

/**
 * The owner-intent routes of the NEAR Intents Agent API (docs.agentsonintents.com), called
 * with the partner key in X-API-Key. That key can create agents, never move their funds.
 */
export function agentApiAccounts(apiKey: string, baseUrl: string, fetcher: typeof fetch = fetch): AgentAccounts {
  const request = async <T>(path: string, body?: unknown): Promise<T> => {
    const res = await fetcher(new URL(path, baseUrl), {
      method: body === undefined ? "GET" : "POST",
      headers: { "X-API-Key": apiKey, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new UpstreamError(res.status);
    return (await res.json()) as T;
  };
  return {
    async find(userId) {
      try {
        const page = await request<{ data: AgentView[] }>(`/v1/agents?external_user_id=${encodeURIComponent(userId)}`);
        const active = page.data.find((a) => a.status === "ACTIVE" && a.wallet && a.owner_account);
        if (!active?.wallet || !active.owner_account) return { status: "none" };
        return { status: "active", agentId: active.id, agentAccount: active.wallet.near_account_id, ownerAccount: active.owner_account.account_id };
      } catch (error) {
        throw unavailable(error);
      }
    },
    async prepare(userId, owner) {
      try {
        const res = await request<{ correlation_id: string; intent: unknown; preview: { summary: string; policy: unknown } }>("/v1/generate-intent", {
          type: "agent_create",
          name: "Inti agent",
          external_user_id: userId,
          owner: { type: "near", account_id: owner.accountId, public_key: owner.publicKey },
          policy: agentPolicy(owner.accountId),
        });
        return { correlationId: res.correlation_id, intent: res.intent, preview: { summary: res.preview.summary, policy: res.preview.policy } };
      } catch (error) {
        throw unavailable(error);
      }
    },
    async prepareGrant(body) {
      try {
        const res = await request<{ correlation_id: string; intent: unknown; preview: { summary: string } }>("/v1/generate-intent", body);
        return { correlationId: res.correlation_id, intent: res.intent, preview: { summary: res.preview.summary } };
      } catch (error) {
        throw unavailable(error);
      }
    },
    async submit(correlationId, signedData, type = "agent_create") {
      try {
        await request("/v1/submit-intent", { type, correlation_id: correlationId, signed_data: signedData });
        const status = await request<StatusResponse>(`/v1/status?correlation_id=${encodeURIComponent(correlationId)}&wait_ms=${STATUS_WAIT_MS}`);
        if (status.status === "SUCCESS") return "success";
        return status.status === "FAILED" || status.status === "REFUNDED" ? "failed" : "processing";
      } catch (error) {
        // A refused signature (expired, wrong key, changed payload) is final: the user starts again.
        if (error instanceof UpstreamError && error.status >= 400 && error.status < 500 && error.status !== 429) return "failed";
        throw unavailable(error);
      }
    },
  };
}
