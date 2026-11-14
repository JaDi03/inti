import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ScriptedBrain } from "../brains/scripted.js";
import { demoPolicy, demoPortfolio } from "../core/demo.js";
import type { PricedToken } from "../core/portfolio.js";
import type { Brain } from "../core/types.js";
import type { AgentEvent } from "../core/tools.js";
import { ASSETS } from "../policy/assets.js";
import { HELD_ASSETS } from "../policy/heldAssets.js";
import type { AgentAccounts } from "./agents.js";
import { buildApp } from "./app.js";
import { dryRunTools, LOG_LINES, partnerQuoteAgent, QUOTES_PER_MESSAGE, type DryRunRecord } from "./dryRun.js";
import type { GrantStore } from "./grants.js";
import { FUNDING_ASSET } from "./orders.js";
import { LIMITS } from "./config.js";
import { DailyQuota } from "./quota.js";

const AGENT_ID = "e".repeat(64);
const TOKENS: PricedToken[] = [
  { asset_id: ASSETS.bitcoin.assetId, symbol: "BTC", decimals: 8, blockchain: "btc", price: 100_000 },
  { asset_id: HELD_ASSETS.gold.assetId, symbol: "XAUT", decimals: 6, blockchain: "eth", price: 4000 },
  { asset_id: FUNDING_ASSET, symbol: "wNEAR", decimals: 24, blockchain: "near", price: 2.5 },
];

function setup(agentId: string | null = AGENT_ID) {
  const quotes: { agentId: string; from: string; to: string; amount: bigint }[] = [];
  const record: DryRunRecord = { log: [], steps: [] };
  const tools = dryRunTools(
    {
      tokens: () => Promise.resolve(TOKENS),
      quoteAgent: () => Promise.resolve(agentId),
      agent: {
        quote: (id, from, to, amount) => {
          quotes.push({ agentId: id, from, to, amount });
          return Promise.resolve({ amountOut: 4945n, minAmountOut: 4895n, costUsd: "0.0065", costPercent: "0.19", seconds: 12 });
        },
      },
    },
    record,
  );
  return { tools, record, quotes };
}

describe("dry-run tools", () => {
  it("offers no tool that moves money", () => {
    const { tools } = setup();
    expect(tools.specs.map((s) => s.name)).toEqual(["get_portfolio", "get_quote", "buy_now", "ask_user"]);
  });

  it("refuses the real money tools by name", async () => {
    const { tools, quotes } = setup();
    for (const name of ["sell_now", "buy_at_price", "send_near_to_wallet", "transfer"]) {
      await expect(tools.run(name, {}, [])).rejects.toThrow("unknown tool");
    }
    expect(quotes).toEqual([]);
  });

  it("a buy asks NEAR Intents for a dry quote and shows where the money would go, buying nothing", async () => {
    const { tools, record, quotes } = setup();
    const events: AgentEvent[] = [];
    const out = JSON.parse(await tools.run("buy_now", { asset: "bitcoin", usd: "5", reason: "asked" }, events)) as Record<string, unknown>;
    expect(out).toMatchObject({ status: "dry_run", nothing_bought: true, receive: "0.00004945", ends_in: "wallet" });
    // 5 USD at 2.5 USD per NEAR is 2 NEAR.
    expect(quotes).toEqual([{ agentId: AGENT_ID, from: FUNDING_ASSET, to: ASSETS.bitcoin.assetId, amount: 2n * 10n ** 24n }]);
    expect(record.log[0]?.request?.body).toMatchObject({ dry: "true", amount: (2n * 10n ** 24n).toString() });
    expect(record.steps.map((s) => s.place)).toEqual(["wallet", "agent", "intents", "wallet"]);
    expect(events.map((e) => e.type)).toEqual(["swap_proposed"]);
  });

  it("gold ends with the agent, as in the real app", async () => {
    const { tools, record } = setup();
    await tools.run("buy_now", { asset: "gold", usd: "5", reason: "asked" }, []);
    expect(record.steps.at(-1)?.place).toBe("agent");
  });

  it("a buy above the practice limit per order is refused before any quote", async () => {
    const { tools, quotes } = setup();
    const out = JSON.parse(await tools.run("buy_now", { asset: "bitcoin", usd: "26", reason: "asked" }, [])) as { status: string };
    expect(out.status).toBe("refused");
    expect(quotes).toEqual([]);
  });

  it("asks the trading service for at most a few quotes per message", async () => {
    const { tools, quotes } = setup();
    for (let i = 0; i < QUOTES_PER_MESSAGE; i++) await tools.run("get_quote", { asset: "bitcoin", usd: "5" }, []);
    await expect(tools.run("get_quote", { asset: "bitcoin", usd: "5" }, [])).rejects.toThrow("at most");
    expect(quotes).toHaveLength(QUOTES_PER_MESSAGE);
  });

  it("stops running tools once the log of one message is full", async () => {
    const { tools, record } = setup();
    for (let i = 0; i < LOG_LINES; i++) await tools.run("get_portfolio", {}, []);
    await expect(tools.run("get_portfolio", {}, [])).rejects.toThrow("too many steps");
    expect(record.log).toHaveLength(LOG_LINES);
  });

  it("without an agent to ask, it prices with the live token list and says so in the log", async () => {
    const { tools, record, quotes } = setup(null);
    const out = JSON.parse(await tools.run("get_quote", { asset: "bitcoin", usd: "5" }, [])) as { receive: string };
    expect(out.receive).toBe("0.00005");
    expect(quotes).toEqual([]);
    expect(record.log[0]).toMatchObject({ request: null, answer: { source: "live_prices" } });
  });
});

describe("partner quote agent", () => {
  it("picks an active agent and never sends the key anywhere but the header", async () => {
    const seen: { url: string; key: string | null }[] = [];
    const fetcher = ((url: URL, init: RequestInit) => {
      seen.push({ url: url.toString(), key: new Headers(init.headers).get("X-API-Key") });
      return Promise.resolve(new Response(JSON.stringify({ data: [{ id: "a".repeat(64), status: "PENDING" }, { id: AGENT_ID, status: "ACTIVE" }] })));
    }) as unknown as typeof fetch;
    const find = partnerQuoteAgent("partner-key", "https://agents.example", fetcher);
    expect(await find()).toBe(AGENT_ID);
    expect(await find()).toBe(AGENT_ID);
    expect(seen).toEqual([{ url: "https://agents.example/v1/agents", key: "partner-key" }]);
  });
});

describe("POST /api/dry-run/chat", () => {
  const fixture = JSON.parse(readFileSync(new URL("../core/fixtures/priced-tokens.json", import.meta.url), "utf8")) as { tokens: PricedToken[] };
  const buyThenReport = () =>
    new ScriptedBrain([
      () => ({ text: "", stop: "tool_use", toolCalls: [{ id: "1", name: "buy_now", input: { asset: "bitcoin", usd: "5", reason: "asked" } }] }),
      () => ({ text: "Dry run: nothing was bought.", stop: "end", toolCalls: [] }),
    ]);
  const server = (quota?: DailyQuota, brain: Brain = buyThenReport()) =>
    buildApp({
      verify: () => Promise.reject(new Error("no sign-in here")),
      brain,
      tokens: () => Promise.resolve([...fixture.tokens, ...TOKENS]),
      agents: {} as AgentAccounts,
      grants: {} as GrantStore,
      policy: demoPolicy,
      newPortfolio: demoPortfolio,
      allowedOrigins: ["https://example.com"],
      agentEnabled: true,
      trustedProxy: null,
      logger: false,
      dryRun: { quoteAgent: () => Promise.resolve(AGENT_ID), agent: { quote: () => Promise.resolve({ amountOut: 4945n, minAmountOut: 4895n, costUsd: null, costPercent: null, seconds: null }) } },
      ...(quota ? { dryRunQuota: quota } : {}),
    });
  const send = (app: Awaited<ReturnType<typeof server>>, payload: unknown, remoteAddress = "127.0.0.1") =>
    app.inject({ method: "POST", url: "/api/dry-run/chat", remoteAddress, headers: { "content-type": "application/json" }, payload: JSON.stringify(payload) });

  it("answers without signing in, with the log and the steps of the money", async () => {
    const res = await send(await server(), { message: "buy 5 dollars of bitcoin" });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ dryRun: boolean; report: string; log: unknown[]; steps: unknown[] }>();
    expect(body.dryRun).toBe(true);
    expect(body.report).toBe("Dry run: nothing was bought.");
    expect(body.log).toHaveLength(1);
    expect(body.steps).toHaveLength(4);
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("refuses a message past the per-client daily cap", async () => {
    const app = await server(new DailyQuota(1, 100));
    expect((await send(app, { message: "hi" })).statusCode).toBe(200);
    const second = await send(app, { message: "hi" });
    expect(second.statusCode).toBe(429);
    expect(second.json()).toEqual({ error: "user_limit" });
  });

  it("runs a few messages at once per network and caps how many run in total", async () => {
    const releases: (() => void)[] = [];
    const waiting: Brain = {
      name: "waiting",
      step: () => new Promise((r) => releases.push(() => r({ role: "assistant", text: "done", toolCalls: [], stop: "end" }))),
    };
    const app = await server(undefined, waiting);
    const ips = ["10.0.0.1", "10.0.0.2", "10.0.0.3", "10.0.0.4"];
    const running = Array.from({ length: LIMITS.dryRunsAtOnceTotal }, (_, i) => send(app, { message: "hi" }, ips[Math.floor(i / LIMITS.dryRunsAtOncePerIp)]));
    await new Promise((r) => setTimeout(r, 10));
    const sameNetwork = await send(app, { message: "hi" }, "10.0.0.1");
    expect(sameNetwork.statusCode).toBe(409);
    expect(sameNetwork.json()).toEqual({ error: "busy" });
    const full = await send(app, { message: "hi" }, "10.0.0.9");
    expect(full.statusCode).toBe(503);
    expect(full.json()).toEqual({ error: "dry_run_full" });
    releases.forEach((release) => release());
    expect((await Promise.all(running)).map((r) => r.statusCode)).toEqual(Array(LIMITS.dryRunsAtOnceTotal).fill(200));
    releases.length = 0;
    const after = send(app, { message: "hi" }, "10.0.0.1");
    await new Promise((r) => setTimeout(r, 10));
    releases.forEach((release) => release());
    expect((await after).statusCode).toBe(200);
  });

  it("shows the practice dashboard without signing in: live prices and the rules every agent signs", async () => {
    const res = await (await server()).inject({ method: "GET", url: "/api/dry-run/dashboard" });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ prices: Record<string, number | null>; agent: { account: string; policy: { sendsOnlyToOwner: boolean; canBuyNow: boolean; destinations: string[] }; held: unknown[] } }>();
    expect(body.prices.bitcoin).toBe(100_000);
    expect(body.agent.account).toBe("practice-agent");
    expect(body.agent.policy).toMatchObject({ sendsOnlyToOwner: true, canBuyNow: true, destinations: ["0".repeat(64)] });
    expect(body.agent.held).toEqual([]);
  });

  it("refuses unknown fields and messages that are too long", async () => {
    const app = await server();
    expect((await send(app, { message: "hi", tools: ["sell_now"] })).statusCode).toBe(400);
    expect((await send(app, { message: "x".repeat(1001) })).statusCode).toBe(400);
  });
});
