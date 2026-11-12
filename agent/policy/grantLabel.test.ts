import { describe, expect, it } from "vitest";
import { grantLabel } from "./grantLabel.js";

describe("grantLabel", () => {
  it("names the site that holds the grant", () => {
    expect(grantLabel("getinti.xyz")).toBe("Inti trading (getinti.xyz)");
    expect(grantLabel("localhost:5173")).toBe("Inti trading (localhost:5173)");
  });

  it("stays within the 64 characters the Agent API accepts", () => {
    const label = grantLabel(`${"a".repeat(80)}.example`);
    expect(label).toHaveLength(64);
    expect(label.endsWith(")")).toBe(true);
  });
});
