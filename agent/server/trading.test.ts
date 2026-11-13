import { describe, expect, it } from "vitest";
import type { PricedToken } from "../core/portfolio.js";
import type { AgentAccounts, AgentLookup } from "./agents.js";
import type { GrantRecord, GrantStore } from "./grants.js";
import { AgentApiRefusal, FUNDING_ASSET, type AgentPort, type ChainPort } from "./orders.js";
import { trading } from "./trading.js";

const ZEC = "nep141:zec.omft.near";
const NOW = Date.parse("2026-11-10T12:00:00Z");
const ACTIVE: AgentLookup = { status: "active", agentId: "agent_1", agentAccount: "cd".repeat(32), ownerAccount: "91".repeat(32) };
const GRANT: GrantRecord = { agentId: "agent_1", token: "ngt_x", expiresAt: "2027-02-08T12:00:00.000Z" };
const TOKENS: PricedToken[] = [
  { asset_id: ZEC, symbol: "ZEC", decimals: 8, blockchain: "zec", price: 956.27 },
  { asset_id: FUNDING_ASSET, symbol: "wNEAR", decimals: 24, blockchain: "near", price: 3.55 },
];

function setup(
  opts: { agent?: AgentLookup; grant?: GrantRecord | null; bound?: number | null; spent?: Record<string, bigint>; spentFails?: boolean; tokens?: PricedToken[]; balancesFail?: boolean } = {},
) {
  const calls: string[] = [];
  let release: () => void = () => undefined;
  // Funding lands on the agent's public balance; a shield moves it to the confidential one.
  let publicBalance = 0n;
  let confidential = 0n;
  const agents = { find: () => Promise.resolve(opts.agent ?? ACTIVE) } as unknown as AgentAccounts;
  const grants: GrantStore = { get: () => (opts.grant === undefined ? GRANT : opts.grant), put: () => Promise.resolve(), users: () => ["did:privy:alice"] };
  const chain: ChainPort = {
    registered: () => Promise.resolve(true),
    limit: () => Promise.resolve({ perOrder: 10n ** 24n, perDay: 10n ** 25n }),
    spentLast24h: (_owner, token) => (opts.spentFails ? Promise.reject(new Error("rpc down")) : Promise.resolve(opts.spent?.[token] ?? 0n)),
    tokenBalance: () => Promise.resolve(10n ** 12n),
    fundAgent: () => {
      calls.push("fund");
      // Holds the order open until the test lets it go; then the agent holds the funds.
      return new Promise((r) => {
        release = () => {
          publicBalance = 10n ** 24n;
          r();
        };
      });
    },
  };
  const agent = {
    available: () => (opts.balancesFail ? Promise.reject(new AgentApiRefusal(401, "invalid_api_key")) : Promise.resolve(new Map([[FUNDING_ASSET, confidential]]))),
    publicHeld: () => Promise.resolve(new Map([[FUNDING_ASSET, publicBalance]])),
    shield: (_a: unknown, _asset: string, amount: bigint) => {
      publicBalance -= amount;
      confidential += amount;
      return Promise.resolve("success");
    },
    quote: () => Promise.resolve({ amountOut: 246n, minAmountOut: 243n, costUsd: "0.01", costPercent: "1.05", seconds: 12 }),
    swap: () => Promise.resolve("failed"),
    withdraw: () => Promise.resolve("success"),
    previewLimit: () => Promise.resolve({ spend: 1n }),
    openLimitOrders: () => Promise.resolve(0),
    signedPriceBound: () => Promise.resolve(opts.bound === undefined ? 300 : opts.bound),
  } as unknown as AgentPort;
  const t = trading({ agents, grants, chain, agent, tokens: () => Promise.resolve(opts.tokens ?? TOKENS), now: () => NOW });
  return { t, calls, release: () => release() };
}

describe("trading", () => {
  it("refuses orders without an agent or a live grant, before anything moves", async () => {
    expect(await setup({ agent: { status: "none" } }).t.buyNow("did:privy:alice", ZEC, 1n)).toEqual({ status: "refused", code: "no_agent" });
    expect(await setup({ grant: null }).t.buyNow("did:privy:alice", ZEC, 1n)).toEqual({ status: "refused", code: "no_grant" });
    const expired = setup({ grant: { ...GRANT, expiresAt: "2026-11-10T13:00:00.000Z" } });
    expect(await expired.t.buyNow("did:privy:alice", ZEC, 1n)).toEqual({ status: "refused", code: "no_grant" });
    const otherAgent = setup({ grant: { ...GRANT, agentId: "agent_0" } });
    expect(await otherAgent.t.buyNow("did:privy:alice", ZEC, 1n)).toEqual({ status: "refused", code: "no_grant" });
  });

  it("quotes for the user's own agent without a grant, and moves nothing", async () => {
    const s = setup({ grant: null });
    expect(await s.t.quote("did:privy:alice", ZEC, 10n ** 23n)).toEqual({ status: "quoted", amountOut: 246n, minAmountOut: 243n, costUsd: "0.01", costPercent: "1.05", seconds: 12 });
    expect(s.calls).toEqual([]);
    expect(await setup({ agent: { status: "none" } }).t.quote("did:privy:alice", ZEC, 1n)).toEqual({ status: "refused", code: "no_agent" });
  });

  it("runs one thing at a time per user, and the sweep waits for an order in flight", async () => {
    const s = setup();
    const first = s.t.buyNow("did:privy:alice", ZEC, 10n ** 23n);
    await new Promise((r) => setTimeout(r, 0));
    expect(await s.t.buyNow("did:privy:alice", ZEC, 10n ** 23n)).toEqual({ status: "refused", code: "busy" });
    expect(await s.t.sweepAll(["did:privy:alice"])).toEqual([]);
    expect(s.calls).toEqual(["fund"]);
    s.release();
    expect(await first).toEqual({ status: "returned", code: "swap_failed" });
  });

  it("reports a sweep that failed, with the service's code, instead of hiding it", async () => {
    expect(await setup({ balancesFail: true }).t.sweepAll(["did:privy:alice"])).toEqual([{ userId: "did:privy:alice", sent: [], stuck: [], error: "invalid_api_key" }]);
    // Nothing held and nothing failed: nothing to report.
    expect(await setup().t.sweepAll(["did:privy:alice"])).toEqual([]);
  });

  it("refuses limit prices outside the band around the market before funding", async () => {
    const s = setup();
    expect(await s.t.buyAtPrice("did:privy:alice", ZEC, 3n * 10n ** 23n, "500", 7)).toEqual({ status: "refused", code: "price_out_of_band" });
    expect(await s.t.buyAtPrice("did:privy:alice", "nep141:unknown.near", 3n * 10n ** 23n, "1", 7)).toEqual({ status: "refused", code: "unknown_asset" });
    expect(s.calls).toEqual([]);
  });

  it("counts buying and selling against one daily limit in dollars, before anything moves", async () => {
    // The daily limit is 10 NEAR (35.50 dollars); 0.03358 ZEC (32.11 dollars) was sold today.
    const s = setup({ spent: { [ZEC.slice("nep141:".length)]: 3_358_000n } });
    expect(await s.t.roomToday(ACTIVE.ownerAccount)).toBe(3_388_454n);
    expect(await s.t.buyNow("did:privy:alice", ZEC, 10n ** 24n)).toEqual({ status: "refused", code: "over_daily_limit" });
    expect(await s.t.buyAtPrice("did:privy:alice", ZEC, 10n ** 24n, "269", 7)).toEqual({ status: "refused", code: "over_daily_limit" });
    // 0.004 ZEC is 3.82 dollars: more than the 3.38 left.
    expect(await s.t.exchange("did:privy:alice", ZEC, FUNDING_ASSET, 400_000n)).toEqual({ status: "refused", code: "over_daily_limit" });
    expect(s.calls).toEqual([]);
    // 0.9 NEAR (3.19 dollars) still fits.
    const fits = s.t.buyNow("did:privy:alice", ZEC, 9n * 10n ** 23n);
    await new Promise((r) => setTimeout(r, 0));
    expect(s.calls).toEqual(["fund"]);
    s.release();
    await fits;
  });

  it("checks a gold purchase against the same daily limit and grant, and runs it one at a time with the sweep", async () => {
    const GOLD = "nep141:eth-0x68749665ff8d2d112fa859aa293f07a622782f38.omft.near";
    const s = setup({ spent: { [ZEC.slice("nep141:".length)]: 3_358_000n } });
    expect(await s.t.buyHeld("did:privy:alice", GOLD, 10n ** 24n)).toEqual({ status: "refused", code: "over_daily_limit" });
    expect(await setup({ grant: null }).t.buyHeld("did:privy:alice", GOLD, 1n)).toEqual({ status: "refused", code: "no_grant" });
    expect(await setup({ grant: null }).t.sellHeld("did:privy:alice", GOLD, 1n)).toEqual({ status: "refused", code: "no_grant" });
    expect(s.calls).toEqual([]);
    const first = s.t.buyHeld("did:privy:alice", GOLD, 9n * 10n ** 23n);
    await new Promise((r) => setTimeout(r, 0));
    expect(await s.t.sellHeld("did:privy:alice", GOLD, 1n)).toEqual({ status: "refused", code: "busy" });
    expect(await s.t.sweepAll(["did:privy:alice"])).toEqual([]);
    s.release();
    expect(await first).toEqual({ status: "returned", code: "swap_failed" });
  });

  it("starts no order when the daily limit cannot be checked", async () => {
    const down = setup({ spentFails: true });
    expect(await down.t.buyNow("did:privy:alice", ZEC, 1n)).toEqual({ status: "refused", code: "limit_unchecked" });
    // Bitcoin was sold today but has no fresh price, so today's total is unknown.
    const unpriced = setup({ spent: { "nbtc.bridge.near": 1n } });
    expect(await unpriced.t.exchange("did:privy:alice", ZEC, FUNDING_ASSET, 1n)).toEqual({ status: "refused", code: "limit_unchecked" });
    expect(await unpriced.t.roomToday(ACTIVE.ownerAccount)).toBeNull();
    // A sale of an asset priced at zero cannot be valued, so it does not start.
    const zero = setup({ tokens: TOKENS.map((t) => (t.asset_id === ZEC ? { ...t, price: 0 } : t)) });
    expect(await zero.t.exchange("did:privy:alice", ZEC, FUNDING_ASSET, 1n)).toEqual({ status: "refused", code: "limit_unchecked" });
    expect([...down.calls, ...unpriced.calls]).toEqual([]);
  });

  it("uses the price bound the user signed, and refuses limit orders when the policy has none", async () => {
    const tight = setup({ bound: 100 });
    expect(await tight.t.buyAtPrice("did:privy:alice", ZEC, 3n * 10n ** 23n, "265", 7)).toEqual({ status: "refused", code: "price_out_of_band" });
    const none = setup({ bound: null });
    expect(await none.t.buyAtPrice("did:privy:alice", ZEC, 3n * 10n ** 23n, "269", 7)).toEqual({ status: "refused", code: "price_out_of_band" });
    expect([...tight.calls, ...none.calls]).toEqual([]);
  });
});
