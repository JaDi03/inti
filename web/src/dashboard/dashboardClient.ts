import type { AssetKey, RetiredKey } from "../../../agent/policy/assets";

/** Public URL of Inti's agent API (INTI_API_URL in the root .env). Not a secret. */
const API_URL = (import.meta.env as Record<string, string | undefined>).INTI_API_URL;

export interface PolicySummary {
  frozen: boolean;
  canBuyNow: boolean;
  canPlaceLimitOrders: boolean;
  maxActionsPerHour: number | null;
  maxPriceGapPercent: string | null;
  sendsOnlyToOwner: boolean;
  /** Every address the agent may send to, as signed. */
  destinations: string[];
  maxDeviationBps: number | null;
  /** When the next rule change opens, or null when it already does. */
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

export interface DashboardData {
  prices: Record<"near" | AssetKey, number | null>;
  /** Prices of assets Inti no longer trades; missing from a server that does not send them yet. */
  retiredPrices?: Record<RetiredKey, number | null>;
  agent: { account: string; grantUntil: string | null; policy: PolicySummary | null; orders: OpenOrder[] | null } | null;
}

/** Today's prices for saving limits; they come with the dashboard, which the server keeps for a few seconds. */
export async function fetchPrices(getAccessToken: () => Promise<string | null>): Promise<DashboardData["prices"]> {
  const token = await getAccessToken();
  const data = token ? await fetchDashboard(token) : null;
  if (!data) throw new Error("Prices are not available right now. Try again in a minute.");
  return data.prices;
}

/** Prices and the user's own agent, from Inti's server. Null when the server cannot be reached. */
export async function fetchDashboard(accessToken: string): Promise<DashboardData | null> {
  if (!API_URL) return null;
  try {
    const res = await fetch(new URL("/api/dashboard", API_URL), {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Partial<DashboardData>;
    return body.prices ? (body as DashboardData) : null;
  } catch {
    return null;
  }
}
