import type { AssetKey } from "../../../agent/policy/assets";
import type { HeldKey, TradableKey } from "../../../agent/policy/heldAssets";

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

/** How much of one asset the agent keeps for its owner, in whole units. */
export interface HeldBalance {
  asset: HeldKey;
  amount: string;
}

export interface DashboardData {
  prices: Record<"near" | TradableKey, number | null>;
  /**
   * `held` is what the agent keeps for its owner (gold, the euro, SOL) and `cash` the NEAR it holds
   * to spend next, in whole NEAR; each is null when it cannot be read.
   */
  agent: { account: string; grantUntil: string | null; policy: PolicySummary | null; orders: OpenOrder[] | null; held: HeldBalance[] | null; cash: string | null } | null;
}

export type CashHome =
  | { status: "done"; sent: string }
  | { status: "pending" | "refused" | "failed"; code?: string }
  | { status: "error"; code: string };

/** Sends all the NEAR the agent holds to the wallet, where it arrives as plain NEAR. */
export async function sendCashHome(accessToken: string): Promise<CashHome> {
  if (!API_URL) return { status: "error", code: "unavailable" };
  try {
    const res = await fetch(new URL("/api/agent/cash/home", API_URL), {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(90_000),
    });
    const body = (await res.json().catch(() => ({}))) as { status?: string; sent?: string; code?: string; error?: string };
    if (!res.ok) return { status: "error", code: body.error ?? "unavailable" };
    if (body.status === "done" && typeof body.sent === "string") return { status: "done", sent: body.sent };
    if (body.status === "pending" || body.status === "refused" || body.status === "failed") return { status: body.status, ...(body.code ? { code: body.code } : {}) };
    return { status: "error", code: "unavailable" };
  } catch (error) {
    // Only a timeout may still settle on the server; any other failure never reached it.
    return error instanceof DOMException && error.name === "TimeoutError" ? { status: "pending" } : { status: "error", code: "unreachable" };
  }
}

export type HeldSale =
  | { status: "done"; received: string }
  | { status: "pending" | "refused" | "kept"; code?: string }
  /** The request itself failed: signed out, too many today, or the server could not be reached. */
  | { status: "error"; code: string };

/** Sells all of one asset the agent keeps, for NEAR sent to the wallet. It can take a minute or two. */
export async function sellHeld(accessToken: string, asset: HeldKey): Promise<HeldSale> {
  if (!API_URL) return { status: "error", code: "unavailable" };
  try {
    const res = await fetch(new URL("/api/held/sell", API_URL), {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ asset }),
      signal: AbortSignal.timeout(180_000),
    });
    const body = (await res.json().catch(() => ({}))) as { status?: string; received?: string; code?: string; error?: string };
    if (!res.ok) return { status: "error", code: body.error ?? "unavailable" };
    if (body.status === "done" && typeof body.received === "string") return { status: "done", received: body.received };
    if (body.status === "pending" || body.status === "refused" || body.status === "kept") return { status: body.status, ...(body.code ? { code: body.code } : {}) };
    return { status: "error", code: "unavailable" };
  } catch (error) {
    // Only a timeout may still settle on the server; any other failure never reached it.
    return error instanceof DOMException && error.name === "TimeoutError" ? { status: "pending" } : { status: "error", code: "unreachable" };
  }
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
