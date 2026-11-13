import { priceToMicro } from "../core/money.js";
import type { PricedToken } from "../core/portfolio.js";
import { ASSET_KEYS, ASSETS } from "../policy/assets.js";
import type { AgentAccounts } from "./agents.js";
import { freeCash, sendCashHome, tradeOnAgent, type CashHomeResult, type InsideResult } from "./agentCash.js";
import { buyHeld, heldBalances, sellHeld, type HeldBuyResult, type HeldSellResult } from "./held.js";
import { usableGrant, type GrantStore } from "./grants.js";
import {
  AgentApiRefusal,
  bandFromPolicy,
  buy,
  buyQuantity,
  exchange,
  FUNDING_ASSET,
  FUNDING_TOKEN,
  placeLimitBuy,
  priceInBand,
  protectedMinOut,
  sweep,
  tokenContract,
  type AgentPort,
  type BuyResult,
  type ChainPort,
  type ExchangeResult,
  type LimitResult,
  type OrderAccount,
  type SwapQuote,
} from "./orders.js";

/** One user's sweep: assets sent home, assets that could not be sent, or why it failed. */
export interface SweepReport {
  userId: string;
  sent: string[];
  stuck: string[];
  error?: string;
}

export type QuoteResult =({ status: "quoted" } & SwapQuote) | { status: "refused"; code: "no_agent" | "no_route" };

/** Why an order never started. */
export type NotStarted = {
  status: "refused";
  code: "no_agent" | "no_grant" | "busy" | "unknown_asset" | "price_out_of_band" | "no_price" | "too_small" | "over_daily_limit" | "limit_unchecked" | "over_order_limit" | "token_not_allowed";
};

/** Trades inside the agent are remembered this long against the daily limit. */
const DAY_MS = 86_400_000;

/** Every token Inti trades, whose orders count against the one daily limit the user sets. */
const TRADED_ASSETS = [FUNDING_ASSET, ...ASSET_KEYS.map((k) => ASSETS[k].assetId)];

/** What `amount` (atomic) of a token is worth at its current price, in micro-dollars. */
function valueMicro(amount: bigint, token: PricedToken): bigint {
  return (amount * priceToMicro(token.price ?? 0)) / 10n ** BigInt(token.decimals);
}

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
  /**
   * What each owner's agent spent from what it already holds, in micro-dollars: Spending Limits
   * only sees money leaving the wallet, so these count against the same daily limit here.
   */
  const spentOnAgent = new Map<string, { at: number; micro: bigint }[]>();
  const agentSpentToday = (owner: string): bigint => {
    const recent = (spentOnAgent.get(owner) ?? []).filter((s) => now() - s.at < DAY_MS);
    spentOnAgent.set(owner, recent);
    return recent.reduce((a, s) => a + s.micro, 0n);
  };

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

  /**
   * What the user's one daily limit still allows today, in micro-dollars, across everything Inti
   * bought, sold or swapped in the last 24 hours. The user sets the limit in NEAR; each token's own
   * on-chain limit still applies on top. Null when it cannot be read, so no order starts unchecked.
   */
  const roomToday = async (owner: string, tokens: readonly PricedToken[]): Promise<bigint | null> => {
    try {
      const priced = (assetId: string) => tokens.find((t) => t.asset_id === assetId && t.price !== null);
      const near = priced(FUNDING_ASSET);
      const limit = await deps.chain.limit(owner, FUNDING_TOKEN);
      if (!near || !limit) return null;
      const spent = await Promise.all(
        TRADED_ASSETS.map(async (assetId) => {
          const amount = await deps.chain.spentLast24h(owner, tokenContract(assetId) ?? "");
          if (amount === 0n) return 0n;
          const token = priced(assetId);
          if (!token) throw new Error("no price for a token spent today");
          return valueMicro(amount, token);
        }),
      );
      const room = valueMicro(limit.perDay, near) - spent.reduce((a, b) => a + b, 0n) - agentSpentToday(owner);
      return room > 0n ? room : 0n;
    } catch {
      return null;
    }
  };

  /** Refuses an order worth `amount` of `assetId` when it does not fit in what today still allows. */
  const checkRoom = async (owner: string, assetId: string, amount: bigint): Promise<NotStarted | null> => {
    const tokens = await deps.tokens();
    const token = tokens.find((t) => t.asset_id === assetId && t.price !== null);
    const room = await roomToday(owner, tokens);
    if (!token || room === null) return { status: "refused", code: "limit_unchecked" };
    try {
      return valueMicro(amount, token) > room ? { status: "refused", code: "over_daily_limit" } : null;
    } catch {
      // A price the money math cannot use leaves the order unchecked, so it does not start.
      return { status: "refused", code: "limit_unchecked" };
    }
  };

  /**
   * Checks a trade the agent pays from what it holds against the owner's per-order and daily limits,
   * and returns its value in micro-dollars to remember once it runs.
   */
  const checkInside = async (owner: string, assetId: string, amount: bigint): Promise<NotStarted | bigint> => {
    const tokens = await deps.tokens();
    const token = tokens.find((t) => t.asset_id === assetId && t.price !== null);
    const near = tokens.find((t) => t.asset_id === FUNDING_ASSET && t.price !== null);
    const limit = await deps.chain.limit(owner, FUNDING_TOKEN).catch(() => undefined);
    if (limit === null) return { status: "refused", code: "token_not_allowed" };
    if (!token || !near || limit === undefined) return { status: "refused", code: "limit_unchecked" };
    try {
      const value = valueMicro(amount, token);
      if (value > valueMicro(limit.perOrder, near)) return { status: "refused", code: "over_order_limit" };
      const over = await checkRoom(owner, assetId, amount);
      return over ?? value;
    } catch {
      return { status: "refused", code: "limit_unchecked" };
    }
  };

  /** Runs a trade from what the agent holds, after the limits, and remembers what it spent. */
  const insideTrade = async (account: OrderAccount, from: string, to: string, amount: bigint): Promise<InsideResult | NotStarted> => {
    // Selling for NEAR only turns what the agent holds into money it can spend; it buys nothing.
    const value = to === FUNDING_ASSET ? 0n : await checkInside(account.owner, from, amount);
    if (typeof value !== "bigint") return value;
    const result = await tradeOnAgent(deps.chain, deps.agent, account, from, to, amount);
    if (value > 0n && (result.status === "done" || result.status === "pending")) {
      spentOnAgent.set(account.owner, [...(spentOnAgent.get(account.owner) ?? []), { at: now(), micro: value }]);
    }
    return result;
  };

  return {
    /** What today's one daily limit still allows, in micro-dollars, or null when it cannot be read. */
    roomToday: async (owner: string): Promise<bigint | null> => roomToday(owner, await deps.tokens()),

    /**
     * Spends `amount` (atomic wNEAR) on `asset` now; the result lands in the user's wallet. It is paid
     * with the NEAR the agent holds when that covers it, otherwise from the wallet.
     */
    buyNow: (userId: string, asset: string, amount: bigint): Promise<BuyResult | InsideResult | NotStarted> =>
      exclusive(userId, async () => {
        const account = await accountOf(userId);
        if ("status" in account) return account;
        if ((await freeCash(deps.agent, account.agentId)) >= amount) return insideTrade(account, FUNDING_ASSET, asset, amount);
        const over = await checkRoom(account.owner, FUNDING_ASSET, amount);
        if (over) return over;
        return buy(deps.chain, deps.agent, account, { buyAsset: asset, amount });
      }),

    /**
     * Spends `amount` (atomic wNEAR) on an asset the agent keeps for the user; it stays on the agent.
     * Paid like `buyNow`: with the agent's NEAR when it covers it, otherwise from the wallet.
     */
    buyHeld: (userId: string, asset: string, amount: bigint): Promise<HeldBuyResult | InsideResult | NotStarted> =>
      exclusive(userId, async () => {
        const account = await accountOf(userId);
        if ("status" in account) return account;
        if ((await freeCash(deps.agent, account.agentId)) >= amount) return insideTrade(account, FUNDING_ASSET, asset, amount);
        const over = await checkRoom(account.owner, FUNDING_ASSET, amount);
        if (over) return over;
        return buyHeld(deps.chain, deps.agent, account, asset, amount);
      }),

    /**
     * Swaps `amount` (atomic) of an asset the agent holds into `to`: NEAR, which stays on the agent to
     * spend next, an asset it keeps, or an asset sent to the wallet. Anything but a sale for NEAR
     * counts against the owner's limits.
     */
    tradeHeld: (userId: string, from: string, to: string, amount: bigint): Promise<InsideResult | NotStarted> =>
      exclusive(userId, async () => {
        const account = await accountOf(userId);
        if ("status" in account) return account;
        return insideTrade(account, from, to, amount);
      }),

    /** Sends all the NEAR the agent holds to the user's wallet. It spends nothing, so no limit applies. */
    sendCashHome: (userId: string): Promise<CashHomeResult | NotStarted> =>
      exclusive(userId, async () => {
        const account = await accountOf(userId);
        if ("status" in account) return account;
        return sendCashHome(deps.agent, account);
      }),

    /** NEAR the user's agent holds, atomic, free or not; zero when there is no agent. */
    async cash(userId: string): Promise<bigint> {
      const agent = await deps.agents.find(userId);
      return agent.status === "active" ? ((await deps.agent.available(agent.agentId)).get(FUNDING_ASSET) ?? 0n) : 0n;
    },

    /**
     * Sells `amount` (atomic) of an asset the agent keeps for NEAR, sent to the user's wallet. It
     * spends nothing from the wallet, so the daily limit does not apply; the money only goes home.
     */
    sellHeld: (userId: string, asset: string, amount: bigint): Promise<HeldSellResult | NotStarted> =>
      exclusive(userId, async () => {
        const account = await accountOf(userId);
        if ("status" in account) return account;
        return sellHeld(deps.agent, account, asset, amount);
      }),

    /** What the user's agent keeps for them, atomic by asset id; empty when there is no agent. */
    async held(userId: string): Promise<Map<string, bigint>> {
      const agent = await deps.agents.find(userId);
      return agent.status === "active" ? heldBalances(deps.agent, agent.agentId) : new Map();
    },

    /**
     * Sells `amount` (atomic) of `from` from the user's wallet for `to`: NEAR, or another asset. The
     * result lands in the user's wallet.
     */
    exchange: (userId: string, from: string, to: string, amount: bigint): Promise<ExchangeResult | NotStarted> =>
      exclusive(userId, async () => {
        const account = await accountOf(userId);
        if ("status" in account) return account;
        const over = await checkRoom(account.owner, from, amount);
        if (over) return over;
        return exchange(deps.chain, deps.agent, account, { from, to, amount });
      }),

    /** What selling `amount` (atomic) of `from` for `to` would give now, directly or through NEAR. Moves nothing. */
    async quoteExchange(userId: string, from: string, to: string, amount: bigint): Promise<QuoteResult> {
      const agent = await deps.agents.find(userId);
      if (agent.status !== "active") return { status: "refused", code: "no_agent" };
      const bound = await deps.agent.signedPriceBound(agent.agentId);
      const direct = await deps.agent.quote(agent.agentId, from, to, amount);
      if (direct) return { status: "quoted", ...direct, minAmountOut: protectedMinOut(direct, bound) };
      if (to === FUNDING_ASSET) return { status: "refused", code: "no_route" };
      const near = await deps.agent.quote(agent.agentId, from, FUNDING_ASSET, amount);
      const second = near && (await deps.agent.quote(agent.agentId, FUNDING_ASSET, to, near.amountOut));
      if (!near || !second) return { status: "refused", code: "no_route" };
      const cost = near.costUsd !== null && second.costUsd !== null ? (Number(near.costUsd) + Number(second.costUsd)).toFixed(2) : null;
      return {
        status: "quoted",
        amountOut: second.amountOut,
        minAmountOut: protectedMinOut(second, bound),
        // Display only: the cost of both steps, as the trading service reports them.
        costUsd: cost,
        costPercent: near.costPercent !== null && second.costPercent !== null ? (Number(near.costPercent) + Number(second.costPercent)).toFixed(2) : null,
        seconds: near.seconds !== null && second.seconds !== null ? near.seconds + second.seconds : null,
      };
    },

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
        const over = await checkRoom(account.owner, FUNDING_ASSET, spend);
        if (over) return over;
        const capped = Math.min(Math.max(days, 1), LIMIT_ORDER_MAX_DAYS);
        const deadline = new Date(now() + capped * 86_400_000).toISOString();
        return placeLimitBuy(deps.chain, deps.agent, account, { buyAsset: asset, quantity, price, deadline });
      }),

    /**
     * Sends home whatever each user's agent holds. Users with an order in flight are skipped this
     * round. Reports every user with something sent, something stuck, or a sweep that failed.
     */
    async sweepAll(userIds: Iterable<string>): Promise<SweepReport[]> {
      const done: SweepReport[] = [];
      for (const userId of userIds) {
        const result = await exclusive(userId, async () => {
          const account = await accountOf(userId);
          return "status" in account ? null : sweep(deps.chain, deps.agent, account);
        }).catch((error: unknown) => ({ error: error instanceof AgentApiRefusal ? error.code : "unavailable" }));
        if (result === null || "status" in result) continue;
        if ("error" in result) done.push({ userId, sent: [], stuck: [], error: result.error });
        else if (result.sent.length > 0 || result.stuck.length > 0) done.push({ userId, ...result });
      }
      return done;
    },
  };
}

export type Trading = ReturnType<typeof trading>;
