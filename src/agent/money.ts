/**
 * USD math in integer micro-dollars (1 USD = 1_000_000). API prices arrive as
 * JSON numbers; they are turned into fixed 6-decimal integers once, here.
 */
export const MICRO = 1_000_000n;

export function priceToMicro(price: number): bigint {
  if (!Number.isFinite(price) || price <= 0) throw new Error(`invalid price: ${price}`);
  const [whole = "0", fraction = ""] = price.toFixed(6).split(".");
  return BigInt(whole) * MICRO + BigInt(fraction.padEnd(6, "0"));
}

/** USD value of an atomic amount, rounded up to the micro-dollar. */
export function usdMicroOf(atomic: bigint, decimals: number, priceMicro: bigint): bigint {
  const scale = 10n ** BigInt(decimals);
  return (atomic * priceMicro + scale - 1n) / scale;
}

export function usdStringToMicro(usd: string): bigint {
  const [whole = "0", fraction = ""] = usd.split(".");
  return BigInt(whole) * MICRO + BigInt(fraction.padEnd(6, "0"));
}

/** Micro-dollars to a 2-decimal USD string, rounded down. */
export function microToUsd(micro: bigint): string {
  const whole = micro / MICRO;
  const cents = ((micro % MICRO) / 10_000n).toString().padStart(2, "0");
  return `${whole}.${cents}`;
}
