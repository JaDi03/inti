import type { AssetKey } from "../../../agent/policy/assets";

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
  agent: { grantUntil: string | null; policy: PolicySummary | null; orders: OpenOrder[] | null } | null;
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
