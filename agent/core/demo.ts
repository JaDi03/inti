import type { Policy } from "@near-intents-agent-api/sdk";
import { buildPolicy } from "../policy/build.js";
import { SimulatedPortfolio, type PricedToken } from "./portfolio.js";

/**
 * Demo setup shared by the CLI and the server until the agent runs on the real
 * Agent API: a fixed policy and a simulated portfolio at live prices. No funds move.
 */
export const USDC_BASE = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
export const USDT_NEAR = "nep141:usdt.tether-token.near";
export const WNEAR = "nep141:wrap.near";

export const DEFAULT_AGENT_API_URL = "https://api.demo.agentsonintents.com";

export function demoPolicy(): Policy {
  return buildPolicy({
    actions: ["swap"],
    assets: [
      { assetId: USDC_BASE, symbol: "USDC", decimals: 6, perTransaction: "25" },
      { assetId: USDT_NEAR, symbol: "USDT", decimals: 6, perTransaction: "25" },
      { assetId: WNEAR, symbol: "wNEAR", decimals: 24 },
    ],
    budget: { dailyUsd: "40" },
  });
}

/** 100 USDC and no NEAR, priced with the live token list. */
export function demoPortfolio(tokens: readonly PricedToken[]): SimulatedPortfolio {
  return new SimulatedPortfolio(tokens, { [USDC_BASE]: 100_000_000n, [WNEAR]: 0n });
}

export async function fetchTokens(baseUrl: string): Promise<PricedToken[]> {
  const res = await fetch(new URL("/v1/tokens", baseUrl), { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`GET /v1/tokens failed with HTTP ${res.status}`);
  const body = (await res.json()) as { data: PricedToken[] };
  return body.data;
}
