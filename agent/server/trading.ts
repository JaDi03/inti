import { priceToMicro } from "../core/money.js";
import type { PricedToken } from "../core/portfolio.js";
import type { AgentAccounts } from "./agents.js";
import { usableGrant, type GrantStore } from "./grants.js";
import {
  bandFromPolicy,
  buy,
  buyQuantity,
  FUNDING_ASSET,
  placeLimitBuy,
  priceInBand,
  protectedMinOut,
  sweep,
  type AgentPort,
  type BuyResult,
  type ChainPort,
  type LimitResult,
  type OrderAccount,
  type SwapQuote,
} from "./orders.js";

export type QuoteResult = ({ status: "quoted" } & SwapQuote) | { status: "refused"; code: "no_agent" | "no_route" };

/** Why an order never started. */
export type NotStarted = { status: "refused"; code: "no_agent" | "no_grant" | "busy" | "unknown_asset" | "price_out_of_band" | "no_price" | "too_small" };

export interface TradingDeps {
  agents: AgentAccounts;
  grants: GrantStore;
  chain: ChainPort;
  agent: AgentPort;
  tokens: () => Promise<PricedToken[]>;
  now?: () => number;
}

/** Longest a limit order may rest; the Agent API allows 7 days. */
export const LIMIT_ORDER_MAX_DAYS = 7;

/**
 * Orders and the sweep for every user, one thing at a time per user, so the sweep never sends
 * home money that an order in flight is about to spend.
 */
export function trading(deps: TradingDeps) {
  const now = deps.now ?? Date.now;
  const busy = new Set<string>();

  /** The user's own agent and live grant, or why there is none. */
  const accountOf = async (userId: string): Promise<OrderAccount | NotStarted> => {
    const agent = await deps.agents.find(userId);
    if (agent.status !== "active") return { status: "refused", code: "no_agent" };
    const grant = usableGrant(deps.grants.get(userId), now());
    if (grant?.agentId !== agent.agentId) return { status: "refused", code: "no_grant" };
    return { owner: agent.ownerAccount, agentId: agent.agentId, grantToken: grant.token };
  };

  const exclusive = async <T>(userId: string, work: () => Promise<T>): Promise<T | NotStarted> => {
    // Marked before any await, so two calls for one user can never both pass.
    if (busy.has(userId)) return { status: "refused", code: "busy" };
    busy.add(userId);
    try {
      return await work();
    } finally {
      busy.delete(userId);
    }
  };

  return {
    /** Spends `amount` (atomic wNEAR) on `asset` now; the result lands in the user's wallet. */
    buyNow: (userId: string, asset: string, amount: bigint): Promise<BuyResult | NotStarted> =>
      exclusive(userId, async () => {
        const account = await accountOf(userId);
        if ("status" in account) return account;
        return buy(deps.chain, deps.agent, account, { buyAsset: asset, amount });
      }),

    /** What buying `asset` with `amount` (atomic wNEAR) would give and cost now. Needs no grant: nothing moves. */
    async quote(userId: string, asset: string, amount: bigint): Promise<QuoteResult> {
      const agent = await deps.agents.find(userId);
      if (agent.status !== "active") return { status: "refused", code: "no_agent" };
      const q = await deps.agent.quote(agent.agentId, FUNDING_ASSET, asset, amount);
      if (!q) return { status: "refused", code: "no_route" };
      // The user sees the same least amount a real buy would accept.
      const bound = await deps.agent.signedPriceBound(agent.agentId);
      return { status: "quoted", ...q, minAmountOut: protectedMinOut(q, bound) };
    },

    /**
     * Buys `asset` with up to `spend` (atomic wNEAR) if it reaches `price` (wNEAR per whole token)
     * within `days`. The money waits on the agent until then.
     */
    buyAtPrice: (userId: string, asset: string, spend: bigint, price: string, days: number): Promise<LimitResult | NotStarted> =>
      exclusive(userId, async () => {
        const account = await accountOf(userId);
        if ("status" in account) return account;
        const tokens = await deps.tokens();
        const bought = tokens.find((t) => t.asset_id === asset);
        const funding = tokens.find((t) => t.asset_id === FUNDING_ASSET);
        if (!bought || !funding) return { status: "refused", code: "unknown_asset" } as const;
        if (bought.price === null || funding.price === null) return { status: "refused", code: "no_price" } as const;
        // The bound comes from the policy the user signed, so Inti can never be looser than it.
        const bound = await deps.agent.signedPriceBound(account.agentId);
        if (bound === null) return { status: "refused", code: "price_out_of_band" } as const;
        if (!priceInBand(price, priceToMicro(bought.price), priceToMicro(funding.price), bandFromPolicy(bound))) {
          return { status: "refused", code: "price_out_of_band" } as const;
        }
        const quantity = buyQuantity(spend, price, bought.decimals, funding.decimals);
        if (quantity <= 0n) return { status: "refused", code: "too_small" } as const;
        const capped = Math.min(Math.max(days, 1), LIMIT_ORDER_MAX_DAYS);
        const deadline = new Date(now() + capped * 86_400_000).toISOString();
        return placeLimitBuy(deps.chain, deps.agent, account, { buyAsset: asset, quantity, price, deadline });
      }),

    /** Sends home whatever each user's agent holds. Users with an order in flight are skipped this round. */
    async sweepAll(userIds: Iterable<string>): Promise<{ userId: string; sent: string[] }[]> {
      const done: { userId: string; sent: string[] }[] = [];
      for (const userId of userIds) {
        const result = await exclusive(userId, async () => {
          const account = await accountOf(userId);
          return "status" in account ? [] : sweep(deps.chain, deps.agent, account);
        }).catch(() => []);
        if (Array.isArray(result) && result.length > 0) done.push({ userId, sent: result });
      }
      return done;
    },
  };
}

export type Trading = ReturnType<typeof trading>;
