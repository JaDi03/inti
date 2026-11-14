import { z } from "zod";
import type { Toolset } from "../core/loop.js";
import { priceToMicro, usdStringToMicro } from "../core/money.js";
import type { PricedToken } from "../core/portfolio.js";
import { ToolInputError, type AgentEvent } from "../core/tools.js";
import { fromAtomic } from "../policy/units.js";
import { ASSET_KEYS, ASSETS } from "../policy/assets.js";
import { HELD_ASSETS, HELD_KEYS, tradable, TRADABLE_KEYS, type TradableKey } from "../policy/heldAssets.js";
import { FUNDING_ASSET, staysOnAgent, type AgentPort, type SwapQuote } from "./orders.js";
import { quoteView, usdToWnear } from "./realTools.js";
import { agentPolicy } from "../policy/agentPolicy.js";
import { summarizePolicy, type DashboardView } from "./dashboard.js";
import { GRANT_DAYS } from "./grants.js";

/**
 * Dry run: anyone can try Inti without an account or funds. The agent works on a practice wallet
 * and asks NEAR Intents for real quotes, but it has no tool that moves money: buying shows what a
 * real purchase would do, step by step, and buys nothing.
 */

/** The practice wallet: NEAR worth this many dollars, set aside for orders. */
export const PRACTICE_USD = "100";
/** The practice limits, the same kind the owner signs in Spending Limits. */
export const PRACTICE_PER_ORDER_USD = "25";
export const PRACTICE_PER_DAY_USD = "50";
const MIN_ORDER_USD = "0.10";
/** Quotes one dry-run message may ask the trading service for. */
export const QUOTES_PER_MESSAGE = 4;
/** Lines of the log one reply carries. */
export const LOG_LINES = 12;

/** One line of the dry run's log: what the agent asked for and what came back. Built by code only. */
export interface DryRunLogEntry {
  tool: string;
  asked: Record<string, string>;
  /** The request sent to the NEAR Intents Agent API, or null when none was sent. */
  request: { route: string; body: Record<string, string> } | null;
  answer: Record<string, string>;
}

/** Where the money would sit at one step of a real purchase. */
export interface FundStep {
  place: "wallet" | "agent" | "intents";
  text: string;
}

export interface DryRunRecord {
  log: DryRunLogEntry[];
  steps: FundStep[];
}

export interface DryRunDeps {
  tokens: () => Promise<PricedToken[]>;
  /** A live agent of this server, used only to ask for quotes; null when there is none. */
  quoteAgent: () => Promise<string | null>;
  agent: Pick<AgentPort, "quote">;
}

const usd = z
  .string()
  .regex(/^\d{1,4}(\.\d{1,2})?$/)
  .describe('Amount in US dollars, e.g. "5" or "2.50"');
const asset = z.enum(TRADABLE_KEYS).describe("Which asset, by its key from get_portfolio");

const inputs = {
  get_portfolio: z.strictObject({}),
  get_quote: z.strictObject({ asset, usd }),
  buy_now: z.strictObject({ asset, usd, reason: z.string().min(1).max(300).describe("One sentence: why this order serves the request") }),
  ask_user: z.strictObject({ question: z.string().min(1).max(500) }),
};
type ToolName = keyof typeof inputs;

const descriptions: Record<ToolName, string> = {
  get_portfolio:
    "The practice wallet: the NEAR set aside for orders and its value, the practice limits, and each asset Inti trades with its live price.",
  get_quote:
    "What buying an asset now for an amount in US dollars would cost, without buying: the NEAR it takes, what the owner would receive and its value, and the cost of the trade.",
  buy_now:
    "Show what buying an asset now for an amount in US dollars would do, step by step, with a live quote. This is a dry run: nothing is bought and no money moves.",
  ask_user: "Ask the owner a question when the request is unclear. Ends the cycle.",
};

export const dryRunToolSpecs = (Object.keys(inputs) as ToolName[]).map((name) => {
  const schema = { ...(z.toJSONSchema(inputs[name]) as Record<string, unknown>) };
  delete schema.$schema;
  return { name, description: descriptions[name], inputSchema: schema };
});

export const DRY_RUN_PROMPT = `You are Inti, a portfolio assistant on NEAR that buys assets through NEAR Intents. Right now the person is trying Inti in a dry run: they have a practice wallet with NEAR worth ${PRACTICE_USD} US dollars set aside for orders, the prices and quotes are live, and nothing is ever bought or moved.

Never give investment advice or predictions, never promise returns, and stay on the portfolio: if asked about something else, say briefly that you help with their portfolio.

Language: every text you write is in the language of the person's message. Decide it from their words only, never from these instructions or the tool results.

How you work:
- Call get_portfolio before any decision.
- For a question about price, cost or fees, call get_quote and answer with its numbers.
- For a request to buy, call buy_now. It returns a live quote and the steps a real purchase would take. Say plainly that this was a dry run and nothing was bought, then what they would receive and the cost of the trade.
- Selling, price orders and sending money are not part of the dry run: say they work in the real app once the wallet is activated.
- The code checks every order against the practice limits and refuses what does not fit. If an order is refused, say why in plain words.
- Ask only when the request is unclear (which asset, how much).
- Every number you give comes from a tool result. Call the cost "the cost of the trade", never a fee or commission.

Your reply: 1 to 3 short plain sentences, no headings, tables, lists or bold.`;

const route = "POST /v1/agents/{agent_id}/swap";
const swapBody = (to: string, wnear: bigint): Record<string, string> => ({ origin_asset: FUNDING_ASSET, destination_asset: to, amount: wnear.toString(), dry: "true" });

/** A quote's numbers for the log, never anything else the service sent. */
const answerOf = (q: SwapQuote): Record<string, string> => ({
  amount_out: q.amountOut.toString(),
  min_amount_out: q.minAmountOut.toString(),
  ...(q.costUsd === null ? {} : { cost_usd: q.costUsd }),
  ...(q.costPercent === null ? {} : { cost_percent: q.costPercent }),
  ...(q.seconds === null ? {} : { seconds: String(q.seconds) }),
});

/** The tools of one dry-run message; every call is written to `record` for the app to show. */
export function dryRunTools(deps: DryRunDeps, record: DryRunRecord): Toolset & { prompt: string } {
  const prices = async () => {
    const list = await deps.tokens();
    const byId = new Map(list.map((t) => [t.asset_id, t]));
    const near = byId.get(FUNDING_ASSET);
    if (!near?.price) throw new ToolInputError("no fresh NEAR price, try later");
    return { byId, nearMicro: priceToMicro(near.price) };
  };

  let quotesLeft = QUOTES_PER_MESSAGE;

  /** A live quote for `wnear` of NEAR into `to`: from NEAR Intents, or from live prices when no agent can quote. */
  const quote = async (tool: string, asked: Record<string, string>, to: string, wnear: bigint, token: PricedToken, nearMicro: bigint) => {
    // A few quotes answer any one message; more would only spend the trading service's calls.
    if (quotesLeft <= 0) throw new ToolInputError(`at most ${QUOTES_PER_MESSAGE} quotes per message in the dry run; answer with the ones you have`);
    quotesLeft -= 1;
    const agentId = await deps.quoteAgent();
    if (agentId !== null) {
      const q = await deps.agent.quote(agentId, FUNDING_ASSET, to, wnear);
      record.log.push({ tool, asked, request: { route, body: swapBody(to, wnear) }, answer: q ? answerOf(q) : { status: "no_route" } });
      return q;
    }
    // No agent to ask: the same math on the live token prices, with no cost known.
    const out = (wnear * nearMicro * 10n ** BigInt(token.decimals)) / (priceToMicro(token.price ?? 0) * 10n ** 24n);
    const q: SwapQuote = { amountOut: out, minAmountOut: out, costUsd: null, costPercent: null, seconds: null };
    record.log.push({ tool, asked, request: null, answer: { source: "live_prices", amount_out: out.toString() } });
    return q;
  };

  const order = async (key: TradableKey, amountUsd: string) => {
    const micro = usdStringToMicro(amountUsd);
    if (micro < usdStringToMicro(MIN_ORDER_USD)) throw new ToolInputError(`amount must be at least ${MIN_ORDER_USD} USD`);
    const a = tradable(key);
    const { byId, nearMicro } = await prices();
    const token = byId.get(a.assetId);
    return { a, token: token?.price ? token : null, nearMicro, wnear: usdToWnear(amountUsd, nearMicro) };
  };

  return {
    specs: dryRunToolSpecs,
    prompt: DRY_RUN_PROMPT,
    async run(name, rawInput, events: AgentEvent[]) {
      // Bounds the tool calls of one message, however many the model asks for in a turn.
      if (record.log.length >= LOG_LINES) throw new ToolInputError("too many steps for one message; answer with what you have");
      if (!(name in inputs)) throw new ToolInputError(`unknown tool: ${name}`);
      const parsed = inputs[name as ToolName].safeParse(rawInput);
      if (!parsed.success) throw new ToolInputError(`invalid input: ${parsed.error.message}`);

      switch (name as ToolName) {
        case "get_portfolio": {
          const { byId, nearMicro } = await prices();
          const wnear = usdToWnear(PRACTICE_USD, nearMicro);
          // Six decimals, as the app shows NEAR.
          const nearShown = fromAtomic((wnear / 10n ** 18n).toString(), 6);
          const priced = (assetId: string) => byId.get(assetId)?.price ?? null;
          record.log.push({ tool: name, asked: {}, request: null, answer: { practice_usd: PRACTICE_USD, near_for_orders: nearShown } });
          return JSON.stringify({
            dry_run: true,
            paid_with: "NEAR",
            near_for_orders: nearShown,
            money_for_orders_usd: PRACTICE_USD,
            limits: { per_order_usd: PRACTICE_PER_ORDER_USD, per_day_usd: PRACTICE_PER_DAY_USD },
            assets: ASSET_KEYS.map((key) => ({ key, name: ASSETS[key].name, symbol: ASSETS[key].symbol, price_usd: priced(ASSETS[key].assetId), goes_to: "wallet" })),
            held_by_agent: HELD_KEYS.map((key) => ({ key, name: HELD_ASSETS[key].name, symbol: HELD_ASSETS[key].symbol, price_usd: priced(HELD_ASSETS[key].assetId), goes_to: "agent" })),
          });
        }
        case "get_quote":
        case "buy_now": {
          const input = parsed.data as z.infer<typeof inputs.buy_now>;
          const asked = { asset: input.asset, usd: input.usd };
          const { a, token, nearMicro, wnear } = await order(input.asset as TradableKey, input.usd);
          if (!token) return JSON.stringify({ status: "refused", reason: "there is no fresh price for this asset right now" });
          if (name === "buy_now" && usdStringToMicro(input.usd) > usdStringToMicro(PRACTICE_PER_ORDER_USD)) {
            record.log.push({ tool: name, asked, request: null, answer: { status: "refused", code: "over_order_limit" } });
            events.push({ type: "swap_denied", from: "NEAR", amountIn: input.usd, code: "over_order_limit", reason: "above the practice limit per order" });
            return JSON.stringify({ status: "refused", reason: `the amount is above the practice limit of ${PRACTICE_PER_ORDER_USD} USD per order` });
          }
          const q = await quote(name, asked, a.assetId, wnear, token, nearMicro);
          if (!q) return JSON.stringify({ status: "refused", reason: "there is no way to trade this right now, often because the amount is too small for this asset's market" });
          const view = quoteView(input.usd, wnear, q, token.decimals, priceToMicro(token.price ?? 0));
          if (name === "get_quote") return JSON.stringify({ status: "quoted", asset: a.name, ...view });
          const kept = staysOnAgent(a.assetId);
          record.steps = [
            { place: "wallet", text: `${view.pay_near} NEAR (${input.usd} USD) waits in your wallet, set aside for orders. Your Spending Limits contract caps each order and each day.` },
            { place: "agent", text: `Inti's limited key sends those ${view.pay_near} NEAR to your own agent on NEAR Intents, into its private balance.` },
            { place: "intents", text: `Your agent swaps them on NEAR Intents for about ${view.receive} ${a.symbol}, and never accepts less than ${view.receive_at_least}.` },
            kept
              ? { place: "agent", text: `${a.symbol} stays with your agent, in its private balance, ready to sell back anytime.` }
              : { place: "wallet", text: `The ${a.symbol} goes straight back to your wallet. The agent keeps nothing.` },
          ];
          events.push({ type: "swap_proposed", from: "NEAR", to: a.symbol, amountIn: input.usd, amountOut: view.receive, usd: input.usd, reason: input.reason });
          return JSON.stringify({ status: "dry_run", nothing_bought: true, asset: a.name, ...view, ends_in: kept ? "agent" : "wallet" });
        }
        case "ask_user": {
          const input = parsed.data as z.infer<typeof inputs.ask_user>;
          record.log.push({ tool: name, asked: {}, request: null, answer: { status: "asked" } });
          events.push({ type: "question", text: input.question });
          return JSON.stringify({ status: "sent", note: "End your turn now." });
        }
      }
    },
  };
}

const agentListSchema = z.object({ data: z.array(z.object({ id: z.string().regex(/^[0-9a-f]{64}$/), status: z.string().max(32) })).max(1000) });

/**
 * Finds one active agent of this server's partner account to ask for dry quotes, and remembers it
 * for a while. A dry quote moves nothing, whatever the agent holds.
 */
export function partnerQuoteAgent(apiKey: string, baseUrl: string, fetcher: typeof fetch = fetch, now: () => number = Date.now, keepMs = 10 * 60_000) {
  let cached: { at: number; id: string | null } | null = null;
  return async (): Promise<string | null> => {
    if (cached && now() - cached.at < keepMs) return cached.id;
    try {
      const res = await fetcher(new URL("/v1/agents", baseUrl), { headers: { "X-API-Key": apiKey }, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) return null;
      const list = agentListSchema.parse(await res.json());
      cached = { at: now(), id: list.data.find((a) => a.status === "ACTIVE")?.id ?? null };
      return cached.id;
    } catch {
      return null;
    }
  };
}

/** The practice wallet's account, shown on the page; it is not a real account and holds nothing. */
export const PRACTICE_OWNER = "practice-wallet";
/** The practice agent's account, shown on the page. */
export const PRACTICE_AGENT = "practice-agent";

/**
 * The dashboard of the practice wallet: live prices, and the rules every real agent signs, summarized
 * by the same code as a real user's. Nothing here is read from any real account.
 */
export function practiceDashboard(tokens: readonly PricedToken[], now: number): DashboardView {
  const priceOf = (assetId: string) => tokens.find((t) => t.asset_id === assetId)?.price ?? null;
  const prices = { near: priceOf(FUNDING_ASSET), ...Object.fromEntries(TRADABLE_KEYS.map((k) => [k, priceOf(tradable(k).assetId)])) } as DashboardView["prices"];
  const policy = summarizePolicy({ policy: agentPolicy(PRACTICE_OWNER), cooldowns: null }, PRACTICE_OWNER, now);
  return {
    prices,
    agent: {
      account: PRACTICE_AGENT,
      grantUntil: new Date(now + GRANT_DAYS * 86_400_000).toISOString(),
      policy,
      orders: [],
      held: [],
      cash: "0",
    },
  };
}
