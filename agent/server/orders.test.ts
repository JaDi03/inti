import { describe, expect, it } from "vitest";
import {
  agentApiPort,
  bandFromPolicy,
  buy,
  buyQuantity,
  FUNDING_ASSET,
  placeLimitBuy,
  priceInBand,
  protectedMinOut,
  sweep,
  tokenContract,
  type AgentPort,
  type ChainPort,
  type OrderAccount,
  type Settled,
} from "./orders.js";

const GOLD = "nep141:eth-0x68749665ff8d2d112fa859aa293f07a622782f38.omft.near";
const ACCOUNT: OrderAccount = { owner: "91".repeat(32), agentId: "agent_1", grantToken: "ngt_x" };
const NEAR = 10n ** 24n;

/** One user's account and agent, with the balances an order moves. */
function world(
  opts: {
    registered?: string[];
    perOrder?: bigint;
    perDay?: bigint;
    spent?: bigint;
    fundFails?: boolean;
    credit?: boolean;
    quote?: { amountOut: bigint; minAmountOut: bigint } | null;
    bound?: number | null;
    swap?: Settled;
    rate?: bigint;
    preview?: { spend: bigint } | { refused: string };
    place?: Settled;
    openOrders?: number;
  } = {},
) {
  const agentHeld = new Map<string, bigint>();
  const log: string[] = [];
  const minOuts: bigint[] = [];
  const chain: ChainPort = {
    registered: (contract) => Promise.resolve((opts.registered ?? [tokenContract(GOLD)]).includes(contract)),
    limit: () => Promise.resolve({ perOrder: opts.perOrder ?? NEAR / 2n, perDay: opts.perDay ?? NEAR }),
    spentLast24h: () => Promise.resolve(opts.spent ?? 0n),
    tokenBalance: () => Promise.resolve(0n),
    fundAgent: (_owner, _token, amount) => {
      if (opts.fundFails) return Promise.reject(new Error("over the daily limit"));
      log.push(`fund ${amount}`);
      if (opts.credit !== false) agentHeld.set(FUNDING_ASSET, (agentHeld.get(FUNDING_ASSET) ?? 0n) + amount);
      return Promise.resolve();
    },
  };
  const agent: AgentPort = {
    available: () => Promise.resolve(new Map(agentHeld)),
    quote: () => {
      const q = opts.quote === undefined ? { amountOut: 250n, minAmountOut: 240n } : opts.quote;
      return Promise.resolve(q && { ...q, costUsd: null, costPercent: null, seconds: null });
    },
    swap: (_a, from, to, amount, minOut) => {
      log.push(`swap ${amount}`);
      minOuts.push(minOut);
      const outcome = opts.swap ?? "success";
      if (outcome === "success") {
        agentHeld.set(from, (agentHeld.get(from) ?? 0n) - amount);
        agentHeld.set(to, (agentHeld.get(to) ?? 0n) + amount / (opts.rate ?? 10n ** 21n));
      }
      return Promise.resolve(outcome);
    },
    withdraw: (_a, asset, amount) => {
      log.push(`withdraw ${asset === FUNDING_ASSET ? "wNEAR" : "GOLD"} ${amount}`);
      agentHeld.set(asset, (agentHeld.get(asset) ?? 0n) - amount);
      return Promise.resolve("success");
    },
    previewLimit: () => Promise.resolve(opts.preview ?? { spend: 275n * 10n ** 21n }),
    placeLimit: (_a, order) => {
      log.push(`place ${order.quantity}@${order.price}`);
      const settled = opts.place ?? "success";
      if (settled === "success") agentHeld.set(FUNDING_ASSET, 0n);
      return Promise.resolve({ settled, orderId: settled === "success" ? "ord_1" : null });
    },
    openLimitOrders: () => Promise.resolve(opts.openOrders ?? 0),
    signedPriceBound: () => Promise.resolve(opts.bound === undefined ? 300 : opts.bound),
  };
  return { chain, agent, agentHeld, log, minOuts };
}

const noWait = () => Promise.resolve();
const ORDER = { buyAsset: GOLD, amount: 3n * 10n ** 23n };

describe("buy", () => {
  it("funds the agent with exactly the order, buys, sends the gold to the wallet and leaves the agent empty", async () => {
    const w = world();
    const result = await buy(w.chain, w.agent, ACCOUNT, ORDER, noWait);
    expect(result).toEqual({ status: "done", spent: ORDER.amount, received: 300n, asset: GOLD });
    expect(w.log).toEqual([`fund ${ORDER.amount}`, `swap ${ORDER.amount}`, "withdraw GOLD 300"]);
    expect([...w.agentHeld.values()].every((v) => v === 0n)).toBe(true);
  });

  it("refuses before moving anything when the wallet cannot hold the token", async () => {
    const w = world({ registered: [] });
    expect(await buy(w.chain, w.agent, ACCOUNT, ORDER, noWait)).toEqual({ status: "refused", code: "asset_not_enabled" });
    expect(await buy(w.chain, w.agent, ACCOUNT, { ...ORDER, buyAsset: "1cs_v1:sol:spl:abc" }, noWait)).toEqual({ status: "refused", code: "asset_not_enabled" });
    expect(w.log).toEqual([]);
  });

  it("refuses before moving anything above the per-order or daily limit", async () => {
    const big = world({ perOrder: ORDER.amount - 1n });
    expect(await buy(big.chain, big.agent, ACCOUNT, ORDER, noWait)).toEqual({ status: "refused", code: "over_order_limit" });
    const late = world({ spent: NEAR - ORDER.amount + 1n });
    expect(await buy(late.chain, late.agent, ACCOUNT, ORDER, noWait)).toEqual({ status: "refused", code: "over_daily_limit" });
    expect([...big.log, ...late.log]).toEqual([]);
  });

  it("reports a refused funding with nothing moved", async () => {
    const w = world({ fundFails: true });
    expect(await buy(w.chain, w.agent, ACCOUNT, ORDER, noWait)).toEqual({ status: "refused", code: "funding_failed" });
    expect(w.log).toEqual([]);
  });

  it("returns the money when there is no route or the swap fails", async () => {
    const noRoute = world({ quote: null });
    expect(await buy(noRoute.chain, noRoute.agent, ACCOUNT, ORDER, noWait)).toEqual({ status: "returned", code: "no_route" });
    expect(noRoute.log.at(-1)).toBe(`withdraw wNEAR ${ORDER.amount}`);
    const failed = world({ swap: "failed" });
    expect(await buy(failed.chain, failed.agent, ACCOUNT, ORDER, noWait)).toEqual({ status: "returned", code: "swap_failed" });
    expect(failed.log.at(-1)).toBe(`withdraw wNEAR ${ORDER.amount}`);
  });

  it("never accepts less than the price protection the user signed", async () => {
    // 1% of a quoted 10000 is a floor of 9900, tighter than the quote's own 9800.
    const tight = world({ quote: { amountOut: 10_000n, minAmountOut: 9_800n }, bound: 100 });
    await buy(tight.chain, tight.agent, ACCOUNT, ORDER, noWait);
    expect(tight.minOuts).toEqual([9_900n]);
    // A quote already tighter than 3% keeps its own minimum.
    const wide = world({ quote: { amountOut: 10_000n, minAmountOut: 9_800n }, bound: 300 });
    await buy(wide.chain, wide.agent, ACCOUNT, ORDER, noWait);
    expect(wide.minOuts).toEqual([9_800n]);
    expect(protectedMinOut({ amountOut: 10_000n, minAmountOut: 9_800n }, null)).toBe(9_800n);
    // 1% below 10001 is 9900.99: the floor rounds up to 9901, never down to 9900.
    expect(protectedMinOut({ amountOut: 10_001n, minAmountOut: 9_000n }, 100)).toBe(9_901n);
  });

  it("leaves a slow funding or swap to the sweep instead of guessing", async () => {
    const slowCredit = world({ credit: false });
    expect(await buy(slowCredit.chain, slowCredit.agent, ACCOUNT, ORDER, noWait)).toEqual({ status: "pending" });
    const slowSwap = world({ swap: "pending" });
    expect(await buy(slowSwap.chain, slowSwap.agent, ACCOUNT, ORDER, noWait)).toEqual({ status: "pending" });
    expect(slowSwap.log.some((l) => l.startsWith("withdraw"))).toBe(false);
  });
});

describe("sweep", () => {
  it("sends everything home, but keeps tokens the wallet cannot hold yet", async () => {
    const w = world({ registered: [] });
    w.agentHeld.set(FUNDING_ASSET, 5n);
    w.agentHeld.set(GOLD, 7n);
    expect(await sweep(w.chain, w.agent, ACCOUNT)).toEqual([FUNDING_ASSET]);
    expect(w.agentHeld.get(GOLD)).toBe(7n);
  });

  it("keeps the funding token while a limit order is open, and still sends what it bought", async () => {
    const w = world({ openOrders: 1 });
    w.agentHeld.set(FUNDING_ASSET, 10n);
    w.agentHeld.set(GOLD, 7n);
    await sweep(w.chain, w.agent, ACCOUNT);
    expect(w.log).toEqual(["withdraw GOLD 7"]);
    expect(w.agentHeld.get(FUNDING_ASSET)).toBe(10n);
  });
});

describe("placeLimitBuy", () => {
  const LIMIT = { buyAsset: GOLD, quantity: 250n, price: "1100", deadline: "2026-11-17T12:00:00Z" };

  it("funds the agent with exactly what the order spends and leaves it resting", async () => {
    const w = world();
    expect(await placeLimitBuy(w.chain, w.agent, ACCOUNT, LIMIT, noWait)).toEqual({ status: "resting", orderId: "ord_1", spend: 275n * 10n ** 21n });
    expect(w.log).toEqual([`fund ${275n * 10n ** 21n}`, "place 250@1100"]);
  });

  it("refuses before moving anything when the Agent API would refuse the price, or the wallet cannot hold the token", async () => {
    const far = world({ preview: { refused: "policy_price_deviation_exceeded" } });
    expect(await placeLimitBuy(far.chain, far.agent, ACCOUNT, LIMIT, noWait)).toEqual({ status: "refused", code: "order_refused", detail: "policy_price_deviation_exceeded" });
    const off = world({ registered: [] });
    expect(await placeLimitBuy(off.chain, off.agent, ACCOUNT, LIMIT, noWait)).toEqual({ status: "refused", code: "asset_not_enabled" });
    const big = world({ perOrder: 10n ** 23n });
    expect(await placeLimitBuy(big.chain, big.agent, ACCOUNT, LIMIT, noWait)).toEqual({ status: "refused", code: "over_order_limit" });
    expect([...far.log, ...off.log, ...big.log]).toEqual([]);
  });

  it("returns the money when the placement fails", async () => {
    const w = world({ place: "failed" });
    expect(await placeLimitBuy(w.chain, w.agent, ACCOUNT, LIMIT, noWait)).toEqual({ status: "returned", code: "placement_failed" });
    expect(w.log.at(-1)).toBe(`withdraw wNEAR ${275n * 10n ** 21n}`);
  });
});

describe("priceInBand", () => {
  // XAUT at 4016.03 USD and NEAR at 3.55 USD: the market is about 1131.3 wNEAR per XAUT.
  const gold = 4_016_030_000n;
  const near = 3_550_000n;
  // The user signed 300 bps; Inti checks 250.
  const band = bandFromPolicy(300);
  it("accepts prices within the signed bound minus the margin, on either side", () => {
    expect(band).toBe(250n);
    expect(priceInBand("1131.3", gold, near, band)).toBe(true);
    expect(priceInBand("1104", gold, near, band)).toBe(true);
    expect(priceInBand("1159", gold, near, band)).toBe(true);
  });
  it("refuses prices the Agent API could refuse after funding, and missing prices", () => {
    expect(priceInBand("1100", gold, near, band)).toBe(false);
    expect(priceInBand("2000", gold, near, band)).toBe(false);
    expect(priceInBand("500", gold, near, band)).toBe(false);
    expect(priceInBand("1131", 0n, near, band)).toBe(false);
  });
  it("follows a tighter bound the user signed", () => {
    const tight = bandFromPolicy(100);
    expect(priceInBand("1131.3", gold, near, tight)).toBe(true);
    expect(priceInBand("1120", gold, near, tight)).toBe(false);
    expect(priceInBand("1131.3", gold, near, bandFromPolicy(50))).toBe(false);
  });
});

describe("buyQuantity", () => {
  it("turns what the user spends into the atomic amount bought at that price", () => {
    // 0.275 wNEAR at 1100 wNEAR per XAUT buys 0.00025 XAUT (250 atomic, 6 decimals).
    expect(buyQuantity(275n * 10n ** 21n, "1100", 6, 24)).toBe(250n);
    expect(buyQuantity(3n * 10n ** 23n, "1131.5", 6, 24)).toBe(265n);
  });
});

describe("agentApiPort.quote", () => {
  /** A fetch that answers every call with `body` and records what was asked. */
  const answering = (status: number, body: unknown) => {
    const asked: { url: string; body: unknown }[] = [];
    const fetcher = ((url: URL, init?: RequestInit) => {
      asked.push({ url: url.toString(), body: JSON.parse(String(init?.body)) as unknown });
      return Promise.resolve(new Response(JSON.stringify(body), { status }));
    }) as typeof fetch;
    return { asked, port: agentApiPort("key", "https://api.example", fetcher) };
  };

  it("asks a dry swap and reads what arrives, the minimum, the fee and the time", async () => {
    // Shape of a real dry answer from the Agent API: 1 USD of wNEAR to XAUT.
    const { asked, port } = answering(200, {
      dry: true,
      type: "swap",
      quote: { amount_out: "246", min_amount_out: "243", time_estimate_seconds: 12 },
      spend: { amount_usd: "1.001610", budget: {} },
      owner_approval: false,
      fee: { amount_usd: "0.010611", percent: "1.05" },
      warnings: [{ code: "insufficient_balance", detail: "", available_amount: "0" }],
    });
    expect(await port.quote("agent_1", FUNDING_ASSET, GOLD, 279n * 10n ** 21n)).toEqual({ amountOut: 246n, minAmountOut: 243n, costUsd: "0.010611", costPercent: "1.05", seconds: 12 });
    expect(asked).toEqual([
      { url: "https://api.example/v1/agents/agent_1/swap", body: { origin_asset: FUNDING_ASSET, destination_asset: GOLD, amount: "279000000000000000000000", dry: true } },
    ]);
  });

  it("is null when the service refuses or answers something unexpected", async () => {
    expect(await answering(400, { errors: [{ code: "unsupported_token" }] }).port.quote("agent_1", FUNDING_ASSET, GOLD, 1n)).toBeNull();
    expect(await answering(200, { quote: { amount_out: "-1", min_amount_out: "1" } }).port.quote("agent_1", FUNDING_ASSET, GOLD, 1n)).toBeNull();
  });
});

describe("tokenContract", () => {
  it("reads only NEAR token ids", () => {
    expect(tokenContract(GOLD)).toBe("eth-0x68749665ff8d2d112fa859aa293f07a622782f38.omft.near");
    expect(tokenContract("nep141:wrap.near")).toBe("wrap.near");
    expect(tokenContract("nep245:v2_1.omni.hot.tg:1100_x")).toBeNull();
    expect(tokenContract("nep141:Bad.near")).toBeNull();
  });
});
