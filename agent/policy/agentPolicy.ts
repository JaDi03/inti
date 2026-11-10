import type { Policy } from "@near-intents-agent-api/sdk";

/** Most actions a user's agent may take in one hour. */
export const AGENT_MAX_ACTIONS_PER_HOUR = 12;

/**
 * The rules every user's agent starts with: it may only swap, and send what it holds back to
 * its owner's account. It carries no amounts of its own, because how much reaches the agent is
 * capped by Spending Limits on the owner's account.
 */
export function agentPolicy(ownerAccountId: string): Policy {
  return {
    frozen: false,
    actions: ["swap", "transfer"],
    confidential: false,
    owner_approval: false,
    assets: "any",
    limits: {},
    max_actions_per_hour: AGENT_MAX_ACTIONS_PER_HOUR,
    destinations: { mode: "only", list: [{ action: "transfer", address: ownerAccountId, confidential: false }] },
    budget: { daily_usd: null, weekly_usd: null, monthly_usd: null },
    timelock_ms: 0,
  };
}
