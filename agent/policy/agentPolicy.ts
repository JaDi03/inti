import type { Policy } from "@near-intents-agent-api/sdk";

/**
 * The policy shape of the live Agent API (GET /openapi.json). It adds limit orders, which the
 * installed SDK types do not list yet.
 */
export type AgentPolicy = Omit<Policy, "actions"> & {
  actions: (Policy["actions"][number] | "limit_order")[];
  limit_order?: { max_deviation_bps: number };
};

/** Most actions a user's agent may take in one hour. */
export const AGENT_MAX_ACTIONS_PER_HOUR = 30;
/** Farthest a limit order may sit from the market price; 300 bps (3%) is the Agent API maximum. */
export const AGENT_LIMIT_ORDER_MAX_DEVIATION_BPS = 300;
/** The price protection a user may pick: Tight 1%, Normal 2%, Wide 3%. */
export const PRICE_PROTECTION_BPS = [100, 200, 300] as const;
export type PriceProtectionBps = (typeof PRICE_PROTECTION_BPS)[number];

/**
 * The rules every user's agent starts with. It may trade (swaps and limit orders, in public or
 * private), and the only place anything can leave to is its owner: their NEAR Intents account or
 * their NEAR wallet. It carries no amounts of its own, because how much reaches the agent is
 * capped by Spending Limits on the owner's account. The owner may later pick a tighter price
 * protection; nothing else changes.
 */
export function agentPolicy(ownerAccountId: string, maxDeviationBps: PriceProtectionBps = AGENT_LIMIT_ORDER_MAX_DEVIATION_BPS): AgentPolicy {
  return {
    frozen: false,
    actions: ["swap", "transfer", "withdraw", "limit_order"],
    confidential: true,
    owner_approval: false,
    assets: "any",
    limits: {},
    max_actions_per_hour: AGENT_MAX_ACTIONS_PER_HOUR,
    destinations: {
      mode: "only",
      list: [
        { action: "transfer", address: ownerAccountId, confidential: false },
        { action: "transfer", address: ownerAccountId, confidential: true },
        { action: "withdraw", chain: "near", address: ownerAccountId, memo: null },
      ],
    },
    budget: { daily_usd: null, weekly_usd: null, monthly_usd: null },
    timelock_ms: 0,
    limit_order: { max_deviation_bps: maxDeviationBps },
  };
}
