/**
 * An asset balance short enough to read: 4 decimals from 1 up, else 6 digits after the leading
 * zeros (0.000224943864376032 ETH reads 0.000224943). Cut, never rounded up past what is held.
 */
export function shortAmount(amount: string): string {
  const [whole = "0", fraction = ""] = amount.split(".");
  const zeros = whole === "0" ? (fraction.match(/^0*/)?.[0].length ?? 0) : 0;
  const kept = fraction.slice(0, whole === "0" ? zeros + 6 : 4).replace(/0+$/, "");
  return kept ? `${whole}.${kept}` : whole;
}
