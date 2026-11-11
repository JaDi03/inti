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

const inputs = {
  get_portfolio: z.strictObject({}),
  get_quote: z.strictObject({ asset, usd }),
  buy_now: z.strictObject({ asset, usd, reason: z.string().min(1).max(300).describe("One sentence: why this purchase serves the request") }),
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
    "The owner's wallet, the assets you can buy with their prices and whether each is enabled, the owner's NEAR set aside for orders, and what the owner's limits still allow today.",
  get_quote:
    "What buying an asset for an amount in US dollars would cost right now, without buying: the NEAR it takes, what the owner would receive, the trading fee and the total cost in percent. Use it for any question about price or fees.",
  buy_now: "Buy an asset now for an amount in US dollars, paid with the owner's NEAR. The result goes to the owner's wallet. The code checks the owner's limits first.",
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
  asset_not_enabled: "this asset is not enabled in the owner's wallet yet; the owner can enable it in Assets",
  token_not_allowed: "the owner's limits do not allow orders yet",
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
  no_route: "there was no way to buy this asset right now; the money went back to the wallet",
  swap_failed: "the purchase failed; the money went back to the wallet",
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
 * A quote in the owner's terms: the NEAR it takes, what arrives and its dollar value, and the
 * total cost (fee plus price difference) as a percent of what is paid, in integer math.
 */
export function quoteView(payUsd: string, wnear: bigint, quote: SwapQuote, decimals: number, priceMicro: bigint) {
  const payMicro = usdStringToMicro(payUsd);
  const receivedMicro = (quote.amountOut * priceMicro) / 10n ** BigInt(decimals);
  const lostMicro = payMicro > receivedMicro ? payMicro - receivedMicro : 0n;
  const costBps = (lostMicro * 10_000n) / payMicro;
  return {
    pay_usd: payUsd,
    pay_near: fromAtomic(((wnear + 10n ** 18n - 1n) / 10n ** 18n).toString(), 6),
    receive: fromAtomic(quote.amountOut.toString(), decimals),
    // Four decimals: on small amounts, cents alone would hide most of the cost.
    receive_usd: `${receivedMicro / 1_000_000n}.${((receivedMicro % 1_000_000n) / 100n).toString().padStart(4, "0")}`,
    receive_at_least: fromAtomic(quote.minAmountOut.toString(), decimals),
    fee_usd: quote.feeUsd,
    fee_percent: quote.feePercent,
    total_cost_percent: `${costBps / 100n}.${(costBps % 100n).toString().padStart(2, "0")}`,
    seconds: quote.seconds,
    note: "An estimate at current prices; nothing was bought.",
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
          const spent = await deps.chain.spentLast24h(deps.owner, FUNDING_TOKEN);
          const nearMicro = priceToMicro(near.price ?? 0);
          const toUsd = (atomic: bigint) => microToUsd((atomic * nearMicro) / 10n ** 24n);
          const assets = await Promise.all(
            ASSET_KEYS.map(async (key) => {
              const a = ASSETS[key];
              const t = byId.get(a.assetId);
              const contract = tokenContract(a.assetId) ?? "";
              const [enabled, held] = await Promise.all([deps.chain.registered(contract, deps.owner), deps.chain.tokenBalance(contract, deps.owner)]);
              return { key, name: a.name, symbol: a.symbol, kind: a.kind, price_usd: t?.price ?? null, enabled, in_wallet: t ? fromAtomic(held.toString(), t.decimals) : "0" };
            }),
          );
          return JSON.stringify({
            paid_with: "NEAR",
            near_for_orders: fromAtomic(wnear.toString(), 24),
            money_for_orders_usd: toUsd(wnear),
            limits: limit ? { per_order_usd: toUsd(limit.perOrder), left_today_usd: toUsd(limit.perDay > spent ? limit.perDay - spent : 0n) } : null,
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
            return JSON.stringify({ status: "order_placed", asset: a.name, usd: input.usd, price_usd: input.price_usd, days: input.days });
          }
          if (result.status === "pending") return JSON.stringify({ status: "in_progress", note: "The order is still being placed." });
          events.push({ type: "swap_denied", from: "NEAR", amountIn: input.usd, code: result.code, reason: REASONS[result.code] ?? result.code });
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
