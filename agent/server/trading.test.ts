import { describe, expect, it } from "vitest";
import type { PricedToken } from "../core/portfolio.js";
import type { AgentAccounts, AgentLookup } from "./agents.js";
import type { GrantRecord, GrantStore } from "./grants.js";
import { FUNDING_ASSET, type AgentPort, type ChainPort } from "./orders.js";
import { trading } from "./trading.js";

const GOLD = "nep141:eth-0x68749665ff8d2d112fa859aa293f07a622782f38.omft.near";
const NOW = Date.parse("2026-11-10T12:00:00Z");
const ACTIVE: AgentLookup = { status: "active", agentId: "agent_1", agentAccount: "cd".repeat(32), ownerAccount: "91".repeat(32) };
const GRANT: GrantRecord = { agentId: "agent_1", token: "ngt_x", expiresAt: "2027-02-08T12:00:00.000Z" };
const TOKENS: PricedToken[] = [
  { asset_id: GOLD, symbol: "XAUT", decimals: 6, blockchain: "eth", price: 4016.03 },
  { asset_id: FUNDING_ASSET, symbol: "wNEAR", decimals: 24, blockchain: "near", price: 3.55 },
];

function setup(opts: { agent?: AgentLookup; grant?: GrantRecord | null; bound?: number | null } = {}) {
  const calls: string[] = [];
  let release: () => void = () => undefined;
  let credited = 0n;
  const agents = { find: () => Promise.resolve(opts.agent ?? ACTIVE) } as unknown as AgentAccounts;
  const grants: GrantStore = { get: () => (opts.grant === undefined ? GRANT : opts.grant), put: () => Promise.resolve(), users: () => ["did:privy:alice"] };
  const chain: ChainPort = {
    registered: () => Promise.resolve(true),
    limit: () => Promise.resolve({ perOrder: 10n ** 24n, perDay: 10n ** 25n }),
    spentLast24h: () => Promise.resolve(0n),
    tokenBalance: () => Promise.resolve(0n),
    fundAgent: () => {
      calls.push("fund");
      // Holds the order open until the test lets it go; then the agent holds the funds.
      return new Promise((r) => {
        release = () => {
          credited = 10n ** 24n;
          r();
        };
      });
    },
  };
  const agent = {
    available: () => Promise.resolve(new Map([[FUNDING_ASSET, credited]])),
    minOut: () => Promise.resolve(null),
    quote: () => Promise.resolve({ amountOut: 246n, minAmountOut: 243n, feeUsd: "0.01", feePercent: "1.05", seconds: 12 }),
    withdraw: () => Promise.resolve("success"),
    previewLimit: () => Promise.resolve({ spend: 1n }),
    openLimitOrders: () => Promise.resolve(0),
    signedPriceBound: () => Promise.resolve(opts.bound === undefined ? 300 : opts.bound),
  } as unknown as AgentPort;
  const t = trading({ agents, grants, chain, agent, tokens: () => Promise.resolve(TOKENS), now: () => NOW });
  return { t, calls, release: () => release() };
}

describe("trading", () => {
  it("refuses orders without an agent or a live grant, before anything moves", async () => {
    expect(await setup({ agent: { status: "none" } }).t.buyNow("did:privy:alice", GOLD, 1n)).toEqual({ status: "refused", code: "no_agent" });
    expect(await setup({ grant: null }).t.buyNow("did:privy:alice", GOLD, 1n)).toEqual({ status: "refused", code: "no_grant" });
    const expired = setup({ grant: { ...GRANT, expiresAt: "2026-11-10T13:00:00.000Z" } });
    expect(await expired.t.buyNow("did:privy:alice", GOLD, 1n)).toEqual({ status: "refused", code: "no_grant" });
    const otherAgent = setup({ grant: { ...GRANT, agentId: "agent_0" } });
    expect(await otherAgent.t.buyNow("did:privy:alice", GOLD, 1n)).toEqual({ status: "refused", code: "no_grant" });
  });

  it("quotes for the user's own agent without a grant, and moves nothing", async () => {
    const s = setup({ grant: null });
    expect(await s.t.quote("did:privy:alice", GOLD, 10n ** 23n)).toEqual({ status: "quoted", amountOut: 246n, minAmountOut: 243n, feeUsd: "0.01", feePercent: "1.05", seconds: 12 });
    expect(s.calls).toEqual([]);
    expect(await setup({ agent: { status: "none" } }).t.quote("did:privy:alice", GOLD, 1n)).toEqual({ status: "refused", code: "no_agent" });
  });

  it("runs one thing at a time per user, and the sweep waits for an order in flight", async () => {
    const s = setup();
    const first = s.t.buyNow("did:privy:alice", GOLD, 10n ** 23n);
    await new Promise((r) => setTimeout(r, 0));
    expect(await s.t.buyNow("did:privy:alice", GOLD, 10n ** 23n)).toEqual({ status: "refused", code: "busy" });
    expect(await s.t.sweepAll(["did:privy:alice"])).toEqual([]);
    expect(s.calls).toEqual(["fund"]);
    s.release();
    expect(await first).toEqual({ status: "returned", code: "no_route" });
  });

  it("refuses limit prices outside the band around the market before funding", async () => {
    const s = setup();
    expect(await s.t.buyAtPrice("did:privy:alice", GOLD, 3n * 10n ** 23n, "2000", 7)).toEqual({ status: "refused", code: "price_out_of_band" });
    expect(await s.t.buyAtPrice("did:privy:alice", "nep141:unknown.near", 3n * 10n ** 23n, "1", 7)).toEqual({ status: "refused", code: "unknown_asset" });
    expect(s.calls).toEqual([]);
  });

  it("uses the price bound the user signed, and refuses limit orders when the policy has none", async () => {
    const tight = setup({ bound: 100 });
    expect(await tight.t.buyAtPrice("did:privy:alice", GOLD, 3n * 10n ** 23n, "1115", 7)).toEqual({ status: "refused", code: "price_out_of_band" });
    const none = setup({ bound: null });
    expect(await none.t.buyAtPrice("did:privy:alice", GOLD, 3n * 10n ** 23n, "1131", 7)).toEqual({ status: "refused", code: "price_out_of_band" });
    expect([...tight.calls, ...none.calls]).toEqual([]);
  });
});
