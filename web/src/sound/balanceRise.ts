import { HELD_ASSETS, HELD_KEYS, type HeldKey } from "../../../agent/policy/heldAssets";
import { toAtomic } from "../../../agent/policy/units";

/** Atomic balances by card: the wallet's assets and what the agent holds. */
export type Balances = ReadonlyMap<string, bigint>;

const NEAR_DECIMALS = 24;

/**
 * The atomic balance of every asset card that was read: the wallet's assets and what the agent
 * holds (its NEAR, gold, the euro, SOL). The wallet's own NEAR is left out, so moving NEAR between
 * the wallet and orders is quiet. A card whose amount cannot be read is left out, never an error.
 */
export function assetBalances(
  walletAssets: readonly { key: string; balance: bigint }[] | null,
  agent: { cash: string | null; held: readonly { asset: HeldKey; amount: string }[] | null } | null | undefined,
): Balances {
  const out = new Map<string, bigint>();
  const put = (card: string, amount: string, decimals: number) => {
    try {
      // toAtomic refuses zero, which is a normal balance here.
      out.set(card, /^0*(\.0*)?$/.test(amount) ? 0n : BigInt(toAtomic(amount, decimals)));
    } catch {
      // Left out: counts as no change.
    }
  };
  for (const row of walletAssets ?? []) out.set(row.key, row.balance);
  if (agent?.cash != null) put("agent-near", agent.cash, NEAR_DECIMALS);
  if (agent?.held) {
    for (const key of HELD_KEYS) put(`agent-${key}`, agent.held.find((h) => h.asset === key)?.amount ?? "0", HELD_ASSETS[key].decimals);
  }
  return out;
}

/**
 * Whether any card holds more than it did. A card read for the first time, or not read this time,
 * counts as no change, so opening the app or a failed read never plays the sound.
 */
export function anyRose(before: Balances | null, after: Balances): boolean {
  if (!before) return false;
  for (const [card, amount] of after) {
    const was = before.get(card);
    if (was !== undefined && amount > was) return true;
  }
  return false;
}
