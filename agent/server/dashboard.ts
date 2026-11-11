import { z } from "zod";
import type { PricedToken } from "../core/portfolio.js";
import { ASSET_KEYS, ASSETS, type AssetKey } from "../policy/assets.js";
import { fromAtomic } from "../policy/units.js";
import type { AgentAccounts } from "./agents.js";
import { usableGrant, type GrantStore } from "./grants.js";
import { FUNDING_ASSET } from "./orders.js";

/** The rules the user signed for their agent, in the terms the dashboard shows. */
export interface PolicySummary {
  frozen: boolean;
  canBuyNow: boolean;
  canPlaceLimitOrders: boolean;
  maxActionsPerHour: number | null;
  /** Farthest a limit order may sit from the market, in percent. */
  maxPriceGapPercent: string | null;
  /** True when every address the agent may send to is the owner's own account. */
  sendsOnlyToOwner: boolean;
  /** Every address the agent may send to, as signed, so the owner can see it is their own. */
  destinations: string[];
  /** The signed price protection in basis points, for the selector. */
  maxDeviationBps: number | null;
  /** When the Agent API accepts the next rule change, or null when it already does. */
  nextChangeAt: string | null;
}

export interface OpenOrder {
  asset: AssetKey | null;
  amount: string | null;
  priceNear: string;
  priceUsd: string | null;
  deadline: string;
  status: string;
}

export interface DashboardView {
  /** USD price of NEAR and of each asset Inti can buy, or null when there is no fresh price. */
  prices: Record<"near" | AssetKey, number | null>;
  /** `account` is the agent's own NEAR account on NEAR Intents, as the Agent API knows it. */
  agent: { account: string; grantUntil: string | null; policy: PolicySummary | null; orders: OpenOrder[] | null } | null;
}

/** What the dashboard reads from the Agent API about one agent. Reads only. */
export interface AgentView {
  policy(agentId: string): Promise<z.infer<typeof policySchema>>;
  openOrders(agentId: string): Promise<z.infer<typeof ordersSchema>["data"]>;
}

const policySchema = z.object({
  policy: z.object({
    frozen: z.boolean().nullish(),
    actions: z.array(z.string()),
    max_actions_per_hour: z.number().int().nonnegative().nullish(),
    limit_order: z.object({ max_deviation_bps: z.number().int().min(0).max(10_000) }).nullish(),
    destinations: z.object({ mode: z.string(), list: z.array(z.object({ address: z.string().max(128).nullish() })).nullish() }).nullish(),
  }),
  cooldowns: z.object({ policy_change_available_at: z.string().max(40).nullable() }).nullish(),
});
const ordersSchema = z.object({
  data: z.array(
    z.object({
      base_asset: z.string(),
      quantity: z.string().regex(/^\d+$/),
      price: z.string().regex(/^\d+(\.\d+)?$/),
      deadline: z.string().max(40),
      fill_status: z.string().max(40),
    }),
  ),
});

/** Longest one read may take before the dashboard shows the part as unavailable. */
const READ_TIMEOUT_MS = 10_000;

/** Reads over the Agent API with the partner key; the user's grant is never needed to read. */
export function agentApiView(apiKey: string, baseUrl: string, fetcher: typeof fetch = fetch): AgentView {
  const get = async (path: string): Promise<unknown> => {
    const res = await fetcher(new URL(path, baseUrl), { headers: { "X-API-Key": apiKey }, signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`agent api answered ${res.status}`);
    return res.json();
  };
  const agentPath = (agentId: string, route: string) => `/v1/agents/${encodeURIComponent(agentId)}/${route}`;
  return {
    policy: async (agentId) => policySchema.parse(await get(agentPath(agentId, "policy"))),
    openOrders: async (agentId) => ordersSchema.parse(await get(`${agentPath(agentId, "limit-orders")}?open=true&limit=20`)).data,
  };
}

export function summarizePolicy(view: z.infer<typeof policySchema>, owner: string, now: number): PolicySummary {
  const { policy } = view;
  const list = policy.destinations?.list ?? [];
  const bps = policy.limit_order?.max_deviation_bps;
  const next = view.cooldowns?.policy_change_available_at ?? null;
  return {
    frozen: policy.frozen === true,
    canBuyNow: policy.actions.includes("swap"),
    canPlaceLimitOrders: policy.actions.includes("limit_order"),
    maxActionsPerHour: policy.max_actions_per_hour ?? null,
    maxPriceGapPercent: bps == null ? null : fromAtomic(bps.toString(), 2),
    sendsOnlyToOwner: policy.destinations?.mode === "only" && list.length > 0 && list.every((d) => d.address === owner),
    destinations: [...new Set(list.flatMap((d) => (d.address ? [d.address] : [])))],
    maxDeviationBps: bps ?? null,
    nextChangeAt: next !== null && Date.parse(next) > now ? next : null,
  };
}

/** One open order in the owner's terms: which asset, how much, and its price in NEAR and dollars. */
export function orderView(order: z.infer<typeof ordersSchema>["data"][number], tokens: readonly PricedToken[]): OpenOrder {
  const key = ASSET_KEYS.find((k) => ASSETS[k].assetId === order.base_asset) ?? null;
  const token = tokens.find((t) => t.asset_id === order.base_asset);
  const near = tokens.find((t) => t.asset_id === FUNDING_ASSET)?.price ?? null;
  const priceNear = Number(order.price);
  return {
    asset: key,
    amount: token ? fromAtomic(order.quantity, token.decimals) : null,
    priceNear: order.price,
    // Display only: the order itself is in NEAR.
    priceUsd: near && Number.isFinite(priceNear) ? (priceNear * near).toFixed(2) : null,
    deadline: order.deadline,
    status: order.fill_status,
  };
}

/** How long one user's dashboard is reused, so opening and refreshing it never floods the Agent API. */
export const DASHBOARD_TTL_MS = 15_000;
/** Users whose dashboard is kept; the oldest is dropped first. */
const MAX_CACHED_USERS = 1000;

/**
 * The dashboard of the signed-in user: prices, and their own agent's rules, permission and open
 * orders. The agent comes from the user's id, never from the request. A part that cannot be read
 * is null, so the rest still shows.
 */
export function dashboard(deps: { agents: AgentAccounts; grants: GrantStore; view: AgentView; tokens: () => Promise<PricedToken[]>; now?: () => number }) {
  const now = deps.now ?? Date.now;
  const cache = new Map<string, { at: number; data: DashboardView }>();
  const soft = async <T>(read: () => Promise<T>): Promise<T | null> => {
    try {
      return await read();
    } catch {
      return null;
    }
  };

  return async (userId: string): Promise<DashboardView> => {
    const hit = cache.get(userId);
    if (hit && now() - hit.at < DASHBOARD_TTL_MS) return hit.data;

    const tokens = (await soft(deps.tokens)) ?? [];
    const priceOf = (assetId: string) => tokens.find((t) => t.asset_id === assetId)?.price ?? null;
    const prices = { near: priceOf(FUNDING_ASSET), ...Object.fromEntries(ASSET_KEYS.map((k) => [k, priceOf(ASSETS[k].assetId)])) } as DashboardView["prices"];

    const agent = await soft(() => deps.agents.find(userId));
    let agentPart: DashboardView["agent"] = null;
    if (agent?.status === "active") {
      const grant = usableGrant(deps.grants.get(userId), now());
      const [policy, orders] = await Promise.all([soft(() => deps.view.policy(agent.agentId)), soft(() => deps.view.openOrders(agent.agentId))]);
      agentPart = {
        account: agent.agentAccount,
        grantUntil: grant?.agentId === agent.agentId ? grant.expiresAt : null,
        policy: policy ? summarizePolicy(policy, agent.ownerAccount, now()) : null,
        orders: orders ? orders.map((o) => orderView(o, tokens)) : null,
      };
    }

    const data: DashboardView = { prices, agent: agentPart };
    if (cache.size >= MAX_CACHED_USERS && !cache.has(userId)) cache.delete(cache.keys().next().value as string);
    cache.set(userId, { at: now(), data });
    return data;
  };
}

export type Dashboard = ReturnType<typeof dashboard>;
