import { describe, expect, it } from "vitest";
import { anyRose, assetBalances } from "./balanceRise";

describe("assetBalances", () => {
  it("reads the agent's real balances, zero included, without throwing", () => {
    // What the owner's agent held on 2026-11-13: no NEAR, dust of gold, some euro, no SOL.
    const agent = { cash: "0", held: [{ asset: "gold" as const, amount: "0.000001" }, { asset: "euro" as const, amount: "0.887683074599091428" }] };
    const read = assetBalances([{ key: "bitcoin", balance: 1421n }], agent);
    expect(Object.fromEntries(read)).toEqual({ bitcoin: 1421n, "agent-near": 0n, "agent-gold": 1n, "agent-euro": 887683074599091428n, "agent-solana": 0n });
  });

  it("leaves out what was not read or cannot be read", () => {
    expect(assetBalances(null, null).size).toBe(0);
    expect(assetBalances(null, { cash: null, held: null }).size).toBe(0);
    expect(assetBalances(null, { cash: "1e5", held: null }).has("agent-near")).toBe(false);
  });
});

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
