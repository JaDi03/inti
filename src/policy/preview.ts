import type { Policy } from "@near-intents-agent-api/sdk";
import { fromAtomic } from "./units.js";

/** Minimal token info, as returned by GET /v1/tokens. */
export interface TokenInfo {
  asset_id: string;
  symbol: string;
  decimals: number;
  blockchain: string;
}

function tokenLabel(assetId: string, tokens: Map<string, TokenInfo>): string {
  const t = tokens.get(assetId);
  return t ? `${t.symbol} (${t.blockchain})` : `unknown asset ${assetId}`;
}

function amountLabel(assetId: string, atomic: string, tokens: Map<string, TokenInfo>): string {
  const t = tokens.get(assetId);
  return t ? `${fromAtomic(atomic, t.decimals)} ${t.symbol}` : `${atomic} atomic units of ${assetId}`;
}

/**
 * Plain-language lines describing exactly what the owner is about to sign.
 * Built from the policy itself, so it cannot drift from the signed object.
 */
export function describePolicy(policy: Policy, tokenList: TokenInfo[]): string[] {
  const tokens = new Map(tokenList.map((t) => [t.asset_id, t]));
  const lines: string[] = [];

  if (policy.frozen) lines.push("The agent is frozen: it cannot do anything.");
  lines.push(`Allowed actions: ${policy.actions.join(", ")}.`);
  lines.push(
    policy.assets === "any"
      ? "It may spend any asset."
      : `It may only spend: ${policy.assets.map((a) => tokenLabel(a, tokens)).join(", ")}.`,
  );

  for (const [assetId, atomic] of Object.entries(policy.limits.per_transaction ?? {})) {
    lines.push(`At most ${amountLabel(assetId, atomic, tokens)} per transaction.`);
  }
  for (const [assetId, atomic] of Object.entries(policy.limits.daily ?? {})) {
    lines.push(`At most ${amountLabel(assetId, atomic, tokens)} per day.`);
  }

  const { daily_usd, weekly_usd, monthly_usd } = policy.budget;
  if (daily_usd !== null) lines.push(`Spending cap: ${daily_usd} USD per day across all assets.`);
  if (weekly_usd !== null) lines.push(`Spending cap: ${weekly_usd} USD per week across all assets.`);
  if (monthly_usd !== null) lines.push(`Spending cap: ${monthly_usd} USD per month across all assets.`);

  const d = policy.destinations;
  if (d.mode === "only" && d.list.length === 0) {
    lines.push("Funds can never leave the agent. Swaps stay inside it.");
  } else if (d.mode === "only") {
    lines.push("Funds may only leave to:");
    for (const entry of d.list) {
      lines.push(
        entry.action === "withdraw"
          ? `  - withdraw to ${entry.address} on ${entry.chain}${entry.memo ? ` (memo ${entry.memo})` : ""}`
          : `  - transfer to ${entry.address}${entry.confidential ? " (confidential)" : ""}`,
      );
    }
  } else if (d.mode === "except") {
    lines.push(`WARNING: funds may leave to ANY address except ${d.list.length} blocked ones.`);
  } else {
    lines.push("WARNING: funds may leave to ANY address.");
  }

  if (policy.max_actions_per_hour !== null) lines.push(`At most ${policy.max_actions_per_hour} actions per hour.`);
  if (policy.timelock_ms > 0) lines.push(`Every action waits ${policy.timelock_ms / 60_000} minutes; you can cancel it.`);
  if (policy.owner_approval) lines.push("You approve every action from your wallet.");
  if (policy.confidential) lines.push("Private (confidential) balances are allowed.");
  if (policy.native) lines.push("WARNING: native keys are on. The rules above do not protect them.");

  return lines;
}
