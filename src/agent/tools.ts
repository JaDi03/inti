import type { Policy } from "@near-intents-agent-api/sdk";
import { z } from "zod";
import { fromAtomic, toAtomic } from "../policy/units.js";
import { checkSwap, recordSpend, type SpendState } from "./guard.js";
import { microToUsd, usdStringToMicro } from "./money.js";
import type { SimulatedPortfolio } from "./portfolio.js";
import type { ToolSpec } from "./types.js";

export type AgentEvent =
  | { type: "swap_executed"; from: string; to: string; amountIn: string; amountOut: string; usd: string; reason: string }
  | { type: "swap_proposed"; from: string; to: string; amountIn: string; amountOut: string; usd: string; reason: string }
  | { type: "swap_denied"; from: string; amountIn: string; code: string; reason: string }
  | { type: "question"; text: string };

export interface ToolContext {
  policy: Policy;
  portfolio: SimulatedPortfolio;
  spend: SpendState;
  /** "propose": swaps wait for the owner. "execute": swaps run inside the policy. */
  mode: "propose" | "execute";
  now: () => number;
  events: AgentEvent[];
}

const amount = z.string().regex(/^\d+(\.\d+)?$/).describe('Decimal amount in token units, e.g. "12.5"');
const assetId = z.string().min(1).describe("asset_id exactly as listed by get_portfolio");

const inputs = {
  get_portfolio: z.strictObject({}),
  get_quote: z.strictObject({ from_asset_id: assetId, to_asset_id: assetId, amount }),
  swap: z.strictObject({
    from_asset_id: assetId,
    to_asset_id: assetId,
    amount,
    reason: z.string().min(1).describe("One sentence: why this swap serves the goal"),
  }),
  ask_user: z.strictObject({ question: z.string().min(1) }),
};

type ToolName = keyof typeof inputs;

const descriptions: Record<ToolName, string> = {
  get_portfolio:
    "Current balances, prices, tradable assets and what is left of today's limits. Call it before deciding.",
  get_quote: "Estimate how much of to_asset_id a swap would return. Moves no funds.",
  swap: "Sell amount of from_asset_id for to_asset_id. The policy is checked first; a denied swap returns the reason.",
  ask_user: "Ask the owner a question when the goal is unclear or a decision needs them. Ends the cycle.",
};

export const toolSpecs: ToolSpec[] = (Object.keys(inputs) as ToolName[]).map((name) => {
  const schema = { ...(z.toJSONSchema(inputs[name]) as Record<string, unknown>) };
  delete schema.$schema;
  return { name, description: descriptions[name], inputSchema: schema };
});

export class ToolInputError extends Error {}

function atomicOf(value: string, decimals: number): bigint {
  try {
    return BigInt(toAtomic(value, decimals));
  } catch (error) {
    throw new ToolInputError(error instanceof Error ? error.message : "invalid amount");
  }
}

function quoteOrFail(ctx: ToolContext, from: string, to: string, atomicIn: bigint): bigint {
  try {
    return ctx.portfolio.quote(from, to, atomicIn);
  } catch {
    throw new ToolInputError("no fresh price for one of the assets, try later");
  }
}

function tradableIds(ctx: ToolContext): string[] {
  const held = ctx.portfolio.holdings().map((h) => h.asset_id);
  const listed = ctx.policy.assets === "any" ? [] : ctx.policy.assets;
  return [...new Set([...held, ...listed])];
}

function requireKnown(ctx: ToolContext, id: string): void {
  if (!tradableIds(ctx).includes(id)) throw new ToolInputError(`asset_id not available to this agent: ${id}`);
}

/** Runs one tool call. Returns a JSON string for the model. Throws ToolInputError on bad input. */
export function runTool(name: string, rawInput: unknown, ctx: ToolContext): string {
  if (!(name in inputs)) throw new ToolInputError(`unknown tool: ${name}`);
  const parsed = inputs[name as ToolName].safeParse(rawInput);
  if (!parsed.success) throw new ToolInputError(`invalid input: ${parsed.error.message}`);

  switch (name as ToolName) {
    case "get_portfolio": {
      const budget = ctx.policy.budget.daily_usd;
      return JSON.stringify({
        simulated: true,
        holdings: ctx.portfolio.holdings(),
        tradable_assets: tradableIds(ctx).map((id) => {
          const t = ctx.portfolio.token(id);
          return { asset_id: id, symbol: t.symbol, blockchain: t.blockchain, price_usd: t.price };
        }),
        limits: {
          per_transaction: Object.fromEntries(
            Object.entries(ctx.policy.limits.per_transaction ?? {}).map(([id, atomic]) => {
              const t = ctx.portfolio.token(id);
              return [t.symbol, fromAtomic(atomic, t.decimals)];
            }),
          ),
          daily_usd_left:
            budget === null
              ? null
              : microToUsd(
                  usdStringToMicro(budget) > ctx.spend.dailyUsdMicro ? usdStringToMicro(budget) - ctx.spend.dailyUsdMicro : 0n,
                ),
        },
      });
    }
    case "get_quote": {
      const input = parsed.data as z.infer<typeof inputs.get_quote>;
      requireKnown(ctx, input.from_asset_id);
      requireKnown(ctx, input.to_asset_id);
      const from = ctx.portfolio.token(input.from_asset_id);
      const to = ctx.portfolio.token(input.to_asset_id);
      const out = quoteOrFail(ctx, from.asset_id, to.asset_id, atomicOf(input.amount, from.decimals));
      return JSON.stringify({ simulated: true, amount_out: fromAtomic(out.toString(), to.decimals), symbol_out: to.symbol });
    }
    case "swap": {
      const input = parsed.data as z.infer<typeof inputs.swap>;
      requireKnown(ctx, input.from_asset_id);
      requireKnown(ctx, input.to_asset_id);
      if (input.from_asset_id === input.to_asset_id) throw new ToolInputError("from and to are the same asset");
      const from = ctx.portfolio.token(input.from_asset_id);
      const to = ctx.portfolio.token(input.to_asset_id);
      const atomicIn = atomicOf(input.amount, from.decimals);
      const now = ctx.now();
      const verdict = checkSwap(ctx.policy, ctx.spend, from, atomicIn, ctx.portfolio.balance(from.asset_id), now);
      if (!verdict.ok) {
        ctx.events.push({ type: "swap_denied", from: from.symbol, amountIn: input.amount, code: verdict.code, reason: verdict.reason });
        return JSON.stringify({ status: "denied", code: verdict.code, reason: verdict.reason });
      }
      const usd = microToUsd(verdict.usdMicro);
      const quoted = fromAtomic(quoteOrFail(ctx, from.asset_id, to.asset_id, atomicIn).toString(), to.decimals);
      const base = { from: from.symbol, to: to.symbol, amountIn: input.amount, amountOut: quoted, usd, reason: input.reason };
      if (ctx.mode === "propose") {
        ctx.events.push({ type: "swap_proposed", ...base });
        return JSON.stringify({ status: "proposed", note: "Waiting for the owner to confirm. Do not repeat it.", ...base });
      }
      ctx.portfolio.swap(from.asset_id, to.asset_id, atomicIn);
      recordSpend(ctx.spend, from.asset_id, atomicIn, verdict.usdMicro, now);
      ctx.events.push({ type: "swap_executed", ...base });
      return JSON.stringify({ status: "executed", simulated: true, ...base });
    }
    case "ask_user": {
      const input = parsed.data as z.infer<typeof inputs.ask_user>;
      ctx.events.push({ type: "question", text: input.question });
      return JSON.stringify({ status: "sent", note: "End your turn now." });
    }
  }
}
