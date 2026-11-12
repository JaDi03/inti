import { describe, expect, it } from "vitest";
import type { PricedToken } from "../core/portfolio.js";
import { agentPolicy } from "../policy/agentPolicy.js";
import type { AgentAccounts, AgentLookup } from "./agents.js";
import { dashboard, DASHBOARD_TTL_MS, orderView, summarizePolicy, type AgentView } from "./dashboard.js";
import type { GrantStore } from "./grants.js";
import { FUNDING_ASSET } from "./orders.js";

const GOLD = "nep141:eth-0x68749665ff8d2d112fa859aa293f07a622782f38.omft.near";
const OWNER = "91".repeat(32);
const NOW = Date.parse("2026-11-10T12:00:00Z");
const TOKENS: PricedToken[] = [
  { asset_id: GOLD, symbol: "XAUT", decimals: 6, blockchain: "eth", price: 4026.83 },
  { asset_id: FUNDING_ASSET, symbol: "wNEAR", decimals: 24, blockchain: "near", price: 3.58 },
];
// Shape of a real open order from GET /v1/agents/{id}/limit-orders.
const ORDER = { base_asset: GOLD, quantity: "97", price: "1145.251396", deadline: "2026-11-12T00:05:13.023Z", fill_status: "awaiting_deposit" };

/** An agent per user and a record of which agent ids were read. */
function setup(lookups: Record<string, AgentLookup>) {
  const read: string[] = [];
  const agents = { find: (userId: string) => Promise.resolve(lookups[userId] ?? { status: "none" }) } as unknown as AgentAccounts;
  const grants: GrantStore = {
    get: (userId) => (userId === "did:privy:alice" ? { agentId: "agent_a", token: "ngt_secret", expiresAt: "2027-02-09T00:03:07.187Z" } : null),
    put: () => Promise.resolve(),
    users: () => [],
  };
  const view: AgentView = {
    policy: (agentId) => {
      read.push(agentId);
      return Promise.resolve({ policy: agentPolicy(OWNER) } as never);
    },
    openOrders: () => Promise.resolve([ORDER]),
  };
  let clock = NOW;
  const d = dashboard({ agents, grants, view, tokens: () => Promise.resolve(TOKENS), now: () => clock });
  return { d, read, tick: (ms: number) => (clock += ms) };
}

const ALICE: AgentLookup = { status: "active", agentId: "agent_a", agentAccount: "c9".repeat(32), ownerAccount: OWNER };

describe("dashboard", () => {
  it("summarizes the policy every user signs", () => {
    expect(summarizePolicy({ policy: agentPolicy(OWNER) } as never, OWNER, NOW)).toEqual({
      frozen: false,
      canBuyNow: true,
      canPlaceLimitOrders: true,
      maxActionsPerHour: 30,
      maxPriceGapPercent: "3",
      sendsOnlyToOwner: true,
      destinations: [OWNER],
      maxDeviationBps: 300,
      nextChangeAt: null,
    });
    expect(summarizePolicy({ policy: agentPolicy(OWNER) } as never, "ab".repeat(32), NOW).sendsOnlyToOwner).toBe(false);
  });

  it("shows when the next rule change opens, only while it is still ahead", () => {
    const at = (iso: string) => summarizePolicy({ policy: agentPolicy(OWNER, 100), cooldowns: { policy_change_available_at: iso } } as never, OWNER, NOW);
    expect(at("2026-11-10T12:10:00.000Z")).toMatchObject({ nextChangeAt: "2026-11-10T12:10:00.000Z", maxDeviationBps: 100, maxPriceGapPercent: "1" });
    expect(at("2026-11-10T11:50:00.000Z").nextChangeAt).toBeNull();
  });

  it("shows an open order in the owner's terms", () => {
    expect(orderView(ORDER, TOKENS)).toEqual({
      asset: "gold",
      amount: "0.000097",
      priceNear: "1145.251396",
      priceUsd: "4100.00",
      deadline: "2026-11-12T00:05:13.023Z",
      status: "awaiting_deposit",
    });
  });

  it("reads only the signed-in user's own agent, and never returns the grant token", async () => {
    const { d, read } = setup({ "did:privy:alice": ALICE });
    const alice = await d("did:privy:alice");
    expect(alice.prices).toMatchObject({ near: 3.58, gold: 4026.83, euro: null });
    expect(alice.agent).toMatchObject({ account: ALICE.agentAccount, grantUntil: "2027-02-09T00:03:07.187Z", policy: { sendsOnlyToOwner: true } });
    expect(JSON.stringify(alice)).not.toContain("ngt_secret");
    expect(await d("did:privy:bob")).toMatchObject({ agent: null });
    expect(read).toEqual(["agent_a"]);
  });

  it("reuses a user's dashboard for a few seconds instead of asking the Agent API again", async () => {
    const { d, read, tick } = setup({ "did:privy:alice": ALICE });
    await d("did:privy:alice");
    await d("did:privy:alice");
    expect(read).toHaveLength(1);
    tick(DASHBOARD_TTL_MS);
    await d("did:privy:alice");
    expect(read).toHaveLength(2);
  });

  it("reads again right after the user's kept copy is dropped, and only theirs", async () => {
    const { d, read } = setup({ "did:privy:alice": ALICE, "did:privy:carol": { ...ALICE, agentId: "agent_c" } });
    await d("did:privy:alice");
    await d("did:privy:carol");
    d.forget("did:privy:alice");
    await d("did:privy:alice");
    await d("did:privy:carol");
    expect(read).toEqual(["agent_a", "agent_c", "agent_a"]);
  });
});
