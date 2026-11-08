import { fromAtomic } from "../policy/units.js";
import { microToUsd, priceToMicro, usdMicroOf } from "./money.js";
import { safeLabel } from "./sanitize.js";

/** Token data as returned by GET /v1/tokens, price in USD or null. */
export interface PricedToken {
  asset_id: string;
  symbol: string;
  decimals: number;
  blockchain: string;
  price: number | null;
}

export interface Holding {
  asset_id: string;
  symbol: string;
  blockchain: string;
  amount: string;
  usd: string | null;
}

/**
 * In-memory portfolio used until the agent runs on the real Agent API.
 * Swaps fill at the live mid price with no fees and no slippage: it is a
 * simulation and every caller labels it as one.
 */
export class SimulatedPortfolio {
  private readonly balances = new Map<string, bigint>();
  private readonly tokens: Map<string, PricedToken>;

  constructor(tokens: readonly PricedToken[], initial: Record<string, bigint>) {
    this.tokens = new Map(
      tokens.map((t) => [t.asset_id, { ...t, symbol: safeLabel(t.symbol), blockchain: safeLabel(t.blockchain) }]),
    );
    for (const [assetId, atomic] of Object.entries(initial)) {
      this.token(assetId);
      this.balances.set(assetId, atomic);
    }
  }

  hasToken(assetId: string): boolean {
    return this.tokens.has(assetId);
  }

  token(assetId: string): PricedToken {
    const t = this.tokens.get(assetId);
    if (!t) throw new Error(`unknown asset_id: ${assetId}`);
    return t;
  }

  balance(assetId: string): bigint {
    return this.balances.get(assetId) ?? 0n;
  }

  holdings(): Holding[] {
    return [...this.balances.entries()].map(([assetId, atomic]) => {
      const t = this.token(assetId);
      return {
        asset_id: assetId,
        symbol: t.symbol,
        blockchain: t.blockchain,
        amount: fromAtomic(atomic.toString(), t.decimals),
        usd: t.price === null ? null : microToUsd(usdMicroOf(atomic, t.decimals, priceToMicro(t.price))),
      };
    });
  }

  /** Atomic amount of `to` received for `atomicIn` of `from` at mid price. */
  quote(from: string, to: string, atomicIn: bigint): bigint {
    const a = this.token(from);
    const b = this.token(to);
    if (a.price === null || b.price === null) throw new Error("price_unavailable");
    const num = atomicIn * priceToMicro(a.price) * 10n ** BigInt(b.decimals);
    const den = priceToMicro(b.price) * 10n ** BigInt(a.decimals);
    return num / den;
  }

  swap(from: string, to: string, atomicIn: bigint): bigint {
    if (this.balance(from) < atomicIn) throw new Error("insufficient_balance");
    const out = this.quote(from, to, atomicIn);
    this.balances.set(from, this.balance(from) - atomicIn);
    this.balances.set(to, this.balance(to) + out);
    return out;
  }
}
