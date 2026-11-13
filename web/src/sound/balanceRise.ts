/** Atomic balances by card: the wallet's NEAR and assets, and what the agent holds. */
export type Balances = ReadonlyMap<string, bigint>;

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
