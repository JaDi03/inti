import { describe, expect, it } from "vitest";
import { shortAmount } from "./shortAmount";

describe("shortAmount", () => {
  it("keeps six digits after the leading zeros of a small balance, cut and not rounded", () => {
    expect(shortAmount("0.000224943864376032")).toBe("0.000224943");
    expect(shortAmount("0.00000422")).toBe("0.00000422");
    expect(shortAmount("0.00020947")).toBe("0.00020947");
  });

  it("keeps four decimals from one up, and drops trailing zeros", () => {
    expect(shortAmount("12.3456789")).toBe("12.3456");
    expect(shortAmount("1.50000")).toBe("1.5");
    expect(shortAmount("3")).toBe("3");
    expect(shortAmount("2.00001")).toBe("2");
  });
});
