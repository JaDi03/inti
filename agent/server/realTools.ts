import { z } from "zod";
import type { Toolset } from "../core/loop.js";
import { microToUsd, priceToMicro, usdStringToMicro } from "../core/money.js";
import type { PricedToken } from "../core/portfolio.js";
import { ToolInputError, type AgentEvent } from "../core/tools.js";
import { fromAtomic } from "../policy/units.js";
import { ASSET_KEYS, ASSETS, type AssetKey } from "../policy/assets.js";
import { FUNDING_ASSET, FUNDING_TOKEN, tokenContract, type ChainPort, type SwapQuote } from "./orders.js";
import type { Trading } from "./trading.js";

/** Smallest and largest order the model may ask for, in USD; the signed limits still apply on top. */
const MIN_ORDER_USD = "0.10";
const MAX_ORDER_USD = "1000";

const usd = z
  .string()
  .regex(/^\d{1,4}(\.\d{1,2})?$/)
  .describe('Amount in US dollars, e.g. "5" or "2.50"');
const asset = z.enum(ASSET_KEYS).describe("Which asset to buy, by its key from get_portfolio");
const sold = z.enum(ASSET_KEYS).describe("Which asset of the owner's wallet to sell, by its key from get_portfolio");
const receive = z.enum(["near", ...ASSET_KEYS]).describe('What the owner receives: "near", or another asset by its key from get_portfolio');
const reason = z.string().min(1).max(300).describe("One sentence: why this order serves the request");

const inputs = {
  get_portfolio: z.strictObject({}),
  get_quote: z.strictObject({ asset, usd }),
  get_sell_quote: z.strictObject({ asset: sold, receive, usd }),
  buy_now: z.strictObject({ asset, usd, reason }),
  sell_now: z.strictObject({ asset: sold, receive, usd, reason }),
  buy_at_price: z.strictObject({
    asset,
    usd,
    price_usd: z
      .string()
      .regex(/^\d{1,7}(\.\d{1,2})?$/)
      .describe("Buy only when one whole unit of the asset costs this many US dollars or less"),
    days: z.number().int().min(1).max(7).describe("How many days the order may wait, 1 to 7"),
  }),
  ask_user: z.strictObject({ question: z.string().min(1).max(500) }),
};
type ToolName = keyof typeof inputs;

const descriptions: Record<ToolName, string> = {
  get_portfolio:
    "The owner's wallet: each asset with its price, whether it is enabled, how much the owner holds and its value; the owner's NEAR set aside for orders; and what the owner's one daily limit still allows today across buying and selling.",
  get_quote:
    "What buying an asset now for an amount in US dollars would cost, without buying: the NEAR it takes, what the owner would receive and its value, and the cost (what the route keeps of the value at current prices). Use it for any question about price, cost or fees of buying now.",
  get_sell_quote:
    "What selling an amount in US dollars of an asset the owner holds would give now, without selling: what the owner would receive (NEAR or another asset) and the cost. Use it for any question about selling or swapping one asset for another.",
  buy_now: "Buy an asset now for an amount in US dollars, paid with the owner's NEAR. The result goes to the owner's wallet. The code checks the owner's limits first.",
  sell_now:
    'Sell an amount in US dollars of an asset the owner holds, now. receive "near" sells it for NEAR, which arrives in the wallet as plain NEAR; to buy with it later the owner adds it as NEAR for orders in Spending limits. Another asset key swaps one asset for the other. The result goes to the owner\'s wallet. The code checks the owner\'s limits and holdings first.',
  buy_at_price: "Place an order that buys the asset only if its price falls to price_usd within the given days. The money waits with the agent until it fills or expires.",
  ask_user: "Ask the owner a question when the request is unclear. Ends the cycle.",
};

export const realToolSpecs = (Object.keys(inputs) as ToolName[]).map((name) => {
  const schema = { ...(z.toJSONSchema(inputs[name]) as Record<string, unknown>) };
  delete schema.$schema;
  return { name, description: descriptions[name], inputSchema: schema };
});

/** Plain-language reasons the model can pass on to the owner. */
const REASONS: Record<string, string> = {
  asset_not_enabled: "this asset is not enabled in the owner's wallet yet; the owner can tap Enable on its card in the portfolio",
  token_not_allowed: "the owner's limits do not allow orders in this asset yet; the owner can save their limits again in Spending limits to include it",
  not_enough: "the owner does not hold that much of this asset",
  limit_unchecked: "the owner's daily limit could not be checked right now, so nothing was done; try again in a minute",
  same_asset: "the asset sold and the asset received are the same",
  over_order_limit: "the amount is above the owner's limit per order",
  over_daily_limit: "the amount is above what the owner's daily limit still allows",
  funding_failed: "the owner's account could not send the money for this order",
  no_agent: "the owner has no agent yet",
  no_grant: "the owner has not let Inti trade yet, or that permission expired",
  busy: "another order for this owner is still running",
  unknown_asset: "this asset is not available right now",
  price_out_of_band: "the price is too far from the market price the owner's limits allow",
  no_price: "there is no fresh price for this asset right now",
  too_small: "the amount is too small for an order",
  order_refused: "the order was refused by the trading service",
  no_route: "there was no way to trade this asset right now; what was sent went back to the wallet",
  swap_failed: "the trade failed; what was sent went back to the wallet",
  placement_failed: "the order could not be placed; the money went back to the wallet",
};

const pricesOf = async (tokens: () => Promise<PricedToken[]>) => {
  const list = await tokens();
  const byId = new Map(list.map((t) => [t.asset_id, t]));
  const near = byId.get(FUNDING_ASSET);
  if (!near?.price) throw new ToolInputError("no fresh NEAR price, try later");
  return { byId, near };
};

/** USD to atomic wNEAR at the current NEAR price, without floats. */
export function usdToWnear(usdAmount: string, nearUsdMicro: bigint): bigint {
  return (usdStringToMicro(usdAmount) * 10n ** 24n) / nearUsdMicro;
}

/** A USD price per whole asset as wNEAR per whole asset, with 6 decimals. */
export function usdPriceToWnear(priceUsd: string, nearUsdMicro: bigint): string {
  const micro = (usdStringToMicro(priceUsd) * 1_000_000n) / nearUsdMicro;
  return fromAtomic(micro.toString(), 6);
}

/**
 * A quote in the owner's terms: the NEAR it takes, what arrives and its dollar value, and one
 * cost: what the route keeps of the value at current prices, as the trading service reports it.
 */
export function quoteView(payUsd: string, wnear: bigint, quote: SwapQuote, decimals: number, priceMicro: bigint) {
  const receivedMicro = (quote.amountOut * priceMicro) / 10n ** BigInt(decimals);
  return {
    pay_usd: payUsd,
    pay_near: fromAtomic(((wnear + 10n ** 18n - 1n) / 10n ** 18n).toString(), 6),
    receive: fromAtomic(quote.amountOut.toString(), decimals),
    // Four decimals: on small amounts, cents alone would hide most of the cost.
    receive_usd: `${receivedMicro / 1_000_000n}.${((receivedMicro % 1_000_000n) / 100n).toString().padStart(4, "0")}`,
    receive_at_least: fromAtomic(quote.minAmountOut.toString(), decimals),
    cost_usd: quote.costUsd,
    cost_percent: quote.costPercent,
    seconds: quote.seconds,
    note: "An estimate for right now; nothing was bought. The cost is what the route keeps of the value at current prices; it moves with the market and is not a fixed commission.",
  };
}

/**
 * The tools that act on one owner's real funds. What can be bought, where it goes and how much
 * are decided here and in Spending Limits, never by the model.
 */
export function realTools(deps: { userId: string; owner: string; trading: Trading; chain: ChainPort; tokens: () => Promise<PricedToken[]> }): Toolset {
  const spend = async (amountUsd: string) => {
    if (usdStringToMicro(amountUsd) < usdStringToMicro(MIN_ORDER_USD) || usdStringToMicro(amountUsd) > usdStringToMicro(MAX_ORDER_USD)) {
      throw new ToolInputError(`amount must be between ${MIN_ORDER_USD} and ${MAX_ORDER_USD} USD`);
    }
    const { byId, near } = await pricesOf(deps.tokens);
    const nearMicro = priceToMicro(near.price ?? 0);
    return { byId, nearMicro, wnear: usdToWnear(amountUsd, nearMicro) };
  };

  /**
   * What a sale of `amountUsd` of an asset sends, in its atomic units. A request for all of it,
   * rounded to cents, may land a little above what the wallet holds: up to 1% above, it sells
   * what is there.
   */
  const toSell = async (key: AssetKey, amountUsd: string, receiveKey: "near" | AssetKey) => {
    if (receiveKey === key) throw new ToolInputError(REASONS.same_asset ?? "same asset");
    if (usdStringToMicro(amountUsd) < usdStringToMicro(MIN_ORDER_USD) || usdStringToMicro(amountUsd) > usdStringToMicro(MAX_ORDER_USD)) {
      throw new ToolInputError(`amount must be between ${MIN_ORDER_USD} and ${MAX_ORDER_USD} USD`);
    }
    const { byId } = await pricesOf(deps.tokens);
    const a = ASSETS[key];
    const token = byId.get(a.assetId);
    if (!token?.price) return null;
    const wanted = (usdStringToMicro(amountUsd) * 10n ** BigInt(token.decimals)) / priceToMicro(token.price);
    const held = await deps.chain.tokenBalance(tokenContract(a.assetId) ?? "", deps.owner);
    const amount = wanted > held && wanted * 99n <= held * 100n ? held : wanted;
    const to = receiveKey === "near" ? FUNDING_ASSET : ASSETS[receiveKey].assetId;
    return { from: a.assetId, to, amount, token, toToken: byId.get(to) };
  };

  return {
    specs: realToolSpecs,
    async run(name, rawInput, events: AgentEvent[]) {
      if (!(name in inputs)) throw new ToolInputError(`unknown tool: ${name}`);
      const parsed = inputs[name as ToolName].safeParse(rawInput);
      if (!parsed.success) throw new ToolInputError(`invalid input: ${parsed.error.message}`);

      switch (name as ToolName) {
        case "get_portfolio": {
          const { byId, near } = await pricesOf(deps.tokens);
          const wnear = await deps.chain.tokenBalance(FUNDING_TOKEN, deps.owner);
          const limit = await deps.chain.limit(deps.owner, FUNDING_TOKEN);
          const nearMicro = priceToMicro(near.price ?? 0);
          const toUsd = (atomic: bigint) => microToUsd((atomic * nearMicro) / 10n ** 24n);
          const assets = await Promise.all(
            ASSET_KEYS.map(async (key) => {
              const a = ASSETS[key];
              const t = byId.get(a.assetId);
              const contract = tokenContract(a.assetId) ?? "";
              const [enabled, held] = await Promise.all([deps.chain.registered(contract, deps.owner), deps.chain.tokenBalance(contract, deps.owner)]);
              const value = t?.price ? microToUsd((held * priceToMicro(t.price)) / 10n ** BigInt(t.decimals)) : null;
              return { key, name: a.name, symbol: a.symbol, kind: a.kind, price_usd: t?.price ?? null, enabled, in_wallet: t ? fromAtomic(held.toString(), t.decimals) : "0", in_wallet_usd: value };
            }),
          );
          // One daily limit across buying and selling; null when it cannot be read right now.
          const room = await deps.trading.roomToday(deps.owner);
          return JSON.stringify({
            paid_with: "NEAR",
            near_for_orders: fromAtomic(wnear.toString(), 24),
            money_for_orders_usd: toUsd(wnear),
            limits: limit
              ? { per_order_usd: toUsd(limit.perOrder), per_day_usd: toUsd(limit.perDay), left_today_usd: room === null ? null : microToUsd(room) }
              : null,
            assets,
          });
        }
        case "get_quote": {
          const input = parsed.data as z.infer<typeof inputs.get_quote>;
          const a = ASSETS[input.asset as AssetKey];
          const { byId, wnear } = await spend(input.usd);
          const bought = byId.get(a.assetId);
          if (!bought?.price) return JSON.stringify({ status: "refused", reason: REASONS.no_price });
          const result = await deps.trading.quote(deps.userId, a.assetId, wnear);
          if (result.status !== "quoted") return JSON.stringify({ status: "refused", reason: REASONS[result.code] ?? result.code });
          return JSON.stringify({ status: "quoted", asset: a.name, ...quoteView(input.usd, wnear, result, bought.decimals, priceToMicro(bought.price)) });
        }
        case "buy_now": {
          const input = parsed.data as z.infer<typeof inputs.buy_now>;
          const a = ASSETS[input.asset as AssetKey];
          const { wnear } = await spend(input.usd);
          const result = await deps.trading.buyNow(deps.userId, a.assetId, wnear);
          if (result.status === "done") {
            events.push({ type: "swap_executed", from: "NEAR", to: a.symbol, amountIn: input.usd, amountOut: "", usd: input.usd, reason: input.reason });
            return JSON.stringify({ status: "bought", asset: a.name, spent_usd: input.usd, note: "It is in the owner's wallet now." });
          }
          if (result.status === "pending") return JSON.stringify({ status: "in_progress", note: "The purchase is still settling; the result will reach the wallet on its own." });
          events.push({ type: "swap_denied", from: "NEAR", amountIn: input.usd, code: result.code, reason: REASONS[result.code] ?? result.code });
          return JSON.stringify({ status: result.status, reason: REASONS[result.code] ?? result.code });
        }
        case "buy_at_price": {
          const input = parsed.data as z.infer<typeof inputs.buy_at_price>;
          const a = ASSETS[input.asset as AssetKey];
          const { wnear, nearMicro } = await spend(input.usd);
          const price = usdPriceToWnear(input.price_usd, nearMicro);
          const result = await deps.trading.buyAtPrice(deps.userId, a.assetId, wnear, price, input.days);
          if (result.status === "resting") {
            events.push({ type: "limit_order_placed", to: a.symbol, usd: input.usd, priceUsd: input.price_usd, days: String(input.days) });
            return JSON.stringify({
              status: "order_placed",
              asset: a.name,
              usd: input.usd,
              price_usd: input.price_usd,
              days: input.days,
              fee: "1Click charges 0.20% on every limit order.",
              leftover: "If the order expires or is cancelled, the money comes back to the wallet as regular NEAR; to place another order the owner adds NEAR for orders again in Spending limits.",
            });
          }
          if (result.status === "pending") return JSON.stringify({ status: "in_progress", note: "The order is still being placed." });
          events.push({ type: "swap_denied", from: "NEAR", amountIn: input.usd, code: result.code, reason: REASONS[result.code] ?? result.code });
          return JSON.stringify({ status: result.status, reason: REASONS[result.code] ?? result.code });
        }
        case "get_sell_quote": {
          const input = parsed.data as z.infer<typeof inputs.get_sell_quote>;
          const sale = await toSell(input.asset as AssetKey, input.usd, input.receive as "near" | AssetKey);
          if (!sale?.toToken?.price) return JSON.stringify({ status: "refused", reason: REASONS.no_price });
          const result = await deps.trading.quoteExchange(deps.userId, sale.from, sale.to, sale.amount);
          if (result.status !== "quoted") return JSON.stringify({ status: "refused", reason: REASONS[result.code] ?? result.code });
          const receivedMicro = (result.amountOut * priceToMicro(sale.toToken.price)) / 10n ** BigInt(sale.toToken.decimals);
          return JSON.stringify({
            status: "quoted",
            sell: fromAtomic(sale.amount.toString(), sale.token.decimals),
            sell_usd: input.usd,
            receive: fromAtomic(result.amountOut.toString(), sale.toToken.decimals),
            receive_usd: microToUsd(receivedMicro),
            receive_at_least: fromAtomic(result.minAmountOut.toString(), sale.toToken.decimals),
            cost_usd: result.costUsd,
            cost_percent: result.costPercent,
            seconds: result.seconds,
            note: "An estimate for right now; nothing was sold.",
          });
        }
        case "sell_now": {
          const input = parsed.data as z.infer<typeof inputs.sell_now>;
          const sale = await toSell(input.asset as AssetKey, input.usd, input.receive as "near" | AssetKey);
          if (!sale) return JSON.stringify({ status: "refused", reason: REASONS.no_price });
          const result = await deps.trading.exchange(deps.userId, sale.from, sale.to, sale.amount);
          const sold = ASSETS[input.asset as AssetKey].symbol;
          const got = input.receive === "near" ? "NEAR" : ASSETS[input.receive as AssetKey].symbol;
          if (result.status === "done") {
            events.push({ type: "swap_executed", from: sold, to: got, amountIn: input.usd, amountOut: "", usd: input.usd, reason: input.reason });
            const note = input.receive === "near" ? "The NEAR is in the owner's wallet as plain NEAR; to buy with it, the owner adds it as NEAR for orders in Spending limits." : "It is in the owner's wallet now.";
            return JSON.stringify({ status: "sold", sold, received: got, sold_usd: input.usd, note });
          }
          if (result.status === "pending") return JSON.stringify({ status: "in_progress", note: "The sale is still settling; the result will reach the wallet on its own." });
          events.push({ type: "swap_denied", from: sold, amountIn: input.usd, code: result.code, reason: REASONS[result.code] ?? result.code });
          return JSON.stringify({ status: result.status, reason: REASONS[result.code] ?? result.code });
        }
        case "ask_user": {
          const input = parsed.data as z.infer<typeof inputs.ask_user>;
          events.push({ type: "question", text: input.question });
          return JSON.stringify({ status: "sent", note: "End your turn now." });
        }
      }
    },
  };
}
