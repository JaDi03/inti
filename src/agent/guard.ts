import type { Policy } from "@near-intents-agent-api/sdk";
import { microToUsd, priceToMicro, usdMicroOf, usdStringToMicro } from "./money.js";
import type { PricedToken } from "./portfolio.js";

/**
 * Code-side limits checked before any action runs. They mirror the Agent API
 * policy rules (actions, assets, per-asset limits, USD budget, action rate)
 * and reuse its error codes; the Agent API enforces them again on its side.
 */
export interface SpendState {
  /** Atomic amount spent per asset_id in the current day. */
  dailyByAsset: Map<string, bigint>;
  /** USD spent in the current day, micro-dollars. */
  dailyUsdMicro: bigint;
  /** Timestamps (ms) of actions, to count the last hour. */
  actionTimes: number[];
}

export function emptySpendState(): SpendState {
  return { dailyByAsset: new Map(), dailyUsdMicro: 0n, actionTimes: [] };
}

export type GuardResult = { ok: true; usdMicro: bigint } | { ok: false; code: string; reason: string };

export function checkSwap(
  policy: Policy,
  state: SpendState,
  from: PricedToken,
  atomicIn: bigint,
  balance: bigint,
  now: number,
): GuardResult {
  const deny = (code: string, reason: string): GuardResult => ({ ok: false, code, reason });

  if (policy.frozen) return deny("wallet_frozen", "the agent is frozen");
  if (!policy.actions.includes("swap")) return deny("policy_action_denied", "swap is not an allowed action");
  if (policy.assets !== "any" && !policy.assets.includes(from.asset_id)) {
    return deny("policy_denied", `${from.symbol} is not in the assets the agent may spend`);
  }
  if (atomicIn <= 0n) return deny("validation_failed", "amount must be greater than zero");
  if (atomicIn > balance) return deny("insufficient_balance", `balance is too low to sell that much ${from.symbol}`);

  const perTx = policy.limits.per_transaction?.[from.asset_id];
  if (perTx !== undefined && atomicIn > BigInt(perTx)) {
    return deny("policy_limit_exceeded", `over the per-transaction limit for ${from.symbol}`);
  }
  const daily = policy.limits.daily?.[from.asset_id];
  const spentAsset = state.dailyByAsset.get(from.asset_id) ?? 0n;
  if (daily !== undefined && spentAsset + atomicIn > BigInt(daily)) {
    return deny("policy_limit_exceeded", `over the daily limit for ${from.symbol}`);
  }

  const recent = state.actionTimes.filter((t) => t > now - 3_600_000).length;
  if (policy.max_actions_per_hour !== null && recent >= policy.max_actions_per_hour) {
    return deny("policy_action_limit_exceeded", "too many actions this hour");
  }

  const dailyUsd = policy.budget.daily_usd;
  if (from.price === null) {
    return dailyUsd === null
      ? { ok: true, usdMicro: 0n }
      : deny("spend_price_unavailable", `no fresh price for ${from.symbol}`);
  }
  const usdMicro = usdMicroOf(atomicIn, from.decimals, priceToMicro(from.price));
  if (dailyUsd !== null) {
    const cap = usdStringToMicro(dailyUsd);
    if (state.dailyUsdMicro + usdMicro > cap) {
      const left = cap > state.dailyUsdMicro ? cap - state.dailyUsdMicro : 0n;
      return deny("spend_budget_exceeded", `over the daily USD budget, ${microToUsd(left)} USD left today`);
    }
  }
  return { ok: true, usdMicro };
}

export function recordSpend(state: SpendState, assetId: string, atomicIn: bigint, usdMicro: bigint, now: number): void {
  state.dailyByAsset.set(assetId, (state.dailyByAsset.get(assetId) ?? 0n) + atomicIn);
  state.dailyUsdMicro += usdMicro;
  state.actionTimes.push(now);
}
