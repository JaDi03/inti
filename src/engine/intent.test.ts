import { describe, expect, it } from "vitest";
import { parseIntent } from "./intent.js";

describe("parseIntent", () => {
  it("accepts a valid swap", () => {
    const intent = parseIntent({
      kind: "swap",
      from: { symbol: "USDC", chain: "base" },
      to: { symbol: "NEAR", chain: "near" },
      amount: "10",
    });
    expect(intent.kind).toBe("swap");
  });

  it("rejects a transfer without recipient", () => {
    expect(() =>
      parseIntent({ kind: "transfer", asset: { symbol: "USDC", chain: "base" }, amount: "5" }),
    ).toThrow();
  });

  it("rejects a negative amount", () => {
    expect(() =>
      parseIntent({
        kind: "swap",
        from: { symbol: "USDC", chain: "base" },
        to: { symbol: "NEAR", chain: "near" },
        amount: "-1",
      }),
    ).toThrow();
  });
});
