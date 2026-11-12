import { describe, expect, it } from "vitest";
import { agentPolicy } from "./agentPolicy.js";
import { buildPolicy } from "./build.js";
import { assertPolicyMatches, policyDifferences } from "./verify.js";
import { fromAtomic, toAtomic } from "./units.js";

const USDC_BASE = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
const USDT_NEAR = "nep141:usdt.tether-token.near";

// The quickstart policy from docs.agentsonintents.com (create-an-agent, step 3), owner alice.near.
const docsPolicy = {
  frozen: false,
  actions: ["swap", "transfer", "withdraw"],
  confidential: false,
  owner_approval: false,
  assets: [USDC_BASE, USDT_NEAR],
  limits: { per_transaction: { [USDC_BASE]: "25000000", [USDT_NEAR]: "25000000" } },
  max_actions_per_hour: null,
  destinations: {
    mode: "only",
    list: [
      { action: "transfer", address: "alice.near", confidential: false },
      { action: "withdraw", chain: "near", address: "alice.near", memo: null },
    ],
  },
  budget: { daily_usd: "50", weekly_usd: null, monthly_usd: null },
  timelock_ms: 0,
};

const docsDraft = {
  actions: ["swap", "transfer", "withdraw"] as const,
  assets: [
    { assetId: USDC_BASE, symbol: "USDC", decimals: 6, perTransaction: "25" },
    { assetId: USDT_NEAR, symbol: "USDT", decimals: 6, perTransaction: "25" },
  ],
  destinations: [
    { action: "transfer" as const, address: "alice.near" },
    { action: "withdraw" as const, chain: "near", address: "alice.near" },
  ],
  budget: { dailyUsd: "50" },
};

describe("units", () => {
  it("converts exactly, without floats", () => {
    expect(toAtomic("25", 6)).toBe("25000000");
    expect(toAtomic("0.1", 24)).toBe("100000000000000000000000");
    expect(fromAtomic("25000000", 6)).toBe("25");
    expect(fromAtomic("1500000", 6)).toBe("1.5");
  });
  it("rejects too many decimals, zero and junk", () => {
    expect(() => toAtomic("1.1234567", 6)).toThrow();
    expect(() => toAtomic("0", 6)).toThrow();
    expect(() => toAtomic("1e3", 6)).toThrow();
  });
});

describe("buildPolicy", () => {
  it("reproduces the official quickstart policy exactly", () => {
    expect(policyDifferences(buildPolicy({ ...docsDraft, actions: [...docsDraft.actions] }), docsPolicy)).toEqual([]);
  });

  it("defaults to a safe swap-only policy where nothing leaves", () => {
    const policy = buildPolicy({ actions: ["swap"], assets: [{ assetId: USDC_BASE, symbol: "USDC", decimals: 6 }] });
    expect(policy.destinations).toEqual({ mode: "only", list: [] });
    expect(policy.native).toBeUndefined();
    expect(policy.frozen).toBe(false);
  });

  it("lowercases EVM withdraw addresses", () => {
    const policy = buildPolicy({
      actions: ["withdraw"],
      assets: [{ assetId: USDC_BASE, symbol: "USDC", decimals: 6 }],
      destinations: [{ action: "withdraw", chain: "base", address: "0xABCDEF0000000000000000000000000000000001" }],
    });
    expect(policy.destinations.list[0]).toMatchObject({ address: "0xabcdef0000000000000000000000000000000001" });
  });

  it("refuses a destination for an action that is not allowed", () => {
    expect(() =>
      buildPolicy({
        actions: ["swap"],
        assets: [{ assetId: USDC_BASE, symbol: "USDC", decimals: 6 }],
        destinations: [{ action: "transfer", address: "bob.near" }],
      }),
    ).toThrow();
  });

  it("refuses USD budgets with more than two decimals", () => {
    expect(() =>
      buildPolicy({
        actions: ["swap"],
        assets: [{ assetId: USDC_BASE, symbol: "USDC", decimals: 6 }],
        budget: { dailyUsd: "10.001" },
      }),
    ).toThrow();
  });
});

describe("assertPolicyMatches", () => {
  const built = buildPolicy({ ...docsDraft, actions: [...docsDraft.actions] });

  it("passes when the API echoes the same policy, in any key order", () => {
    const reordered = JSON.parse(JSON.stringify(docsPolicy)) as Record<string, unknown>;
    expect(() => assertPolicyMatches(built, { timelock_ms: 0, ...reordered })).not.toThrow();
  });

  it("aborts when a destination was swapped", () => {
    const tampered = structuredClone(docsPolicy);
    tampered.destinations.list[0] = { action: "transfer", address: "mallory.near", confidential: false };
    expect(() => assertPolicyMatches(built, tampered)).toThrow(/destinations\.list/);
  });

  it("aborts when destinations were opened to any address", () => {
    const tampered = { ...structuredClone(docsPolicy), destinations: { mode: "any", list: [] } };
    expect(policyDifferences(built, tampered)).toContain("destinations.mode");
  });

  it("aborts when native keys were added", () => {
    const tampered = { ...structuredClone(docsPolicy), native: { near: { sign_message: [], transfer: true, call: [] } } };
    expect(policyDifferences(built, tampered)).toContain("native");
  });
});

describe("the rules every agent starts with", () => {
  const owner = "ab".repeat(32);
  const policy = agentPolicy(owner);

  it("lets the agent send only to its owner, by transfer or withdrawal", () => {
    expect(policy.destinations.mode).toBe("only");
    expect(policy.destinations.list.length).toBeGreaterThan(0);
    for (const destination of policy.destinations.list) expect(destination.address).toBe(owner);
  });

  it("names only confidential transfer destinations, the only kind the Agent API takes in a new policy", () => {
    const transfers = policy.destinations.list.filter((d) => d.action === "transfer");
    expect(transfers.length).toBeGreaterThan(0);
    for (const t of transfers) expect(t).toMatchObject({ confidential: true });
  });

  it("allows trading, private balances and limit orders within the API maximum", () => {
    expect([...policy.actions].sort()).toEqual(["limit_order", "swap", "transfer", "withdraw"]);
    expect(policy.confidential).toBe(true);
    expect(policy.limit_order?.max_deviation_bps).toBe(300);
    expect(policy.frozen).toBe(false);
  });

  it("is the same for the same owner, so the app can compare it with the API preview", () => {
    expect(policyDifferences(agentPolicy(owner), policy)).toEqual([]);
    expect(policyDifferences(agentPolicy("cd".repeat(32)), policy)).not.toEqual([]);
  });
});
