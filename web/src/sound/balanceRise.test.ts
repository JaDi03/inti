import { describe, expect, it } from "vitest";
import { anyRose } from "./balanceRise";

describe("anyRose", () => {
  it("is true only when a card already read holds more than before", () => {
    const before = new Map([
      ["near", 10n],
      ["bitcoin", 0n],
    ]);
    expect(anyRose(before, new Map([["near", 10n], ["bitcoin", 5n]]))).toBe(true);
    // NEAR spent on bitcoin: one card down, one up, still a rise.
    expect(anyRose(before, new Map([["near", 4n], ["bitcoin", 5n]]))).toBe(true);
    expect(anyRose(before, new Map([["near", 9n], ["bitcoin", 0n]]))).toBe(false);
    expect(anyRose(before, before)).toBe(false);
  });

  it("stays quiet on the first read and for cards it has not seen before", () => {
    expect(anyRose(null, new Map([["near", 10n]]))).toBe(false);
    expect(anyRose(new Map([["near", 10n]]), new Map([["near", 10n], ["gold", 7n]]))).toBe(false);
  });
});
