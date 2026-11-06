/**
 * Exact decimal-to-atomic conversion. Never uses floats.
 * toAtomic("25", 6) === "25000000"; toAtomic("0.5", 6) === "500000".
 */
const DECIMAL = /^(\d+)(?:\.(\d+))?$/;

export function toAtomic(amount: string, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 77) {
    throw new Error(`invalid decimals: ${decimals}`);
  }
  const match = DECIMAL.exec(amount);
  if (!match) throw new Error(`invalid amount: "${amount}"`);
  const whole = match[1] ?? "0";
  const fraction = match[2] ?? "";
  if (fraction.length > decimals) {
    throw new Error(`amount "${amount}" has more than ${decimals} decimals`);
  }
  const atomic = BigInt(whole + fraction.padEnd(decimals, "0"));
  if (atomic === 0n) throw new Error(`amount must be greater than zero: "${amount}"`);
  return atomic.toString();
}

export function fromAtomic(atomic: string, decimals: number): string {
  if (!/^\d+$/.test(atomic)) throw new Error(`invalid atomic amount: "${atomic}"`);
  const padded = atomic.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals);
  const fraction = padded.slice(padded.length - decimals).replace(/0+$/, "");
  return fraction ? `${BigInt(whole).toString()}.${fraction}` : BigInt(whole).toString();
}

/** USD caps in the Agent API: a string with at most two decimals. */
export function toUsd(amount: string): string {
  if (!/^\d+(\.\d{1,2})?$/.test(amount)) {
    throw new Error(`invalid USD amount (max 2 decimals): "${amount}"`);
  }
  return amount;
}
