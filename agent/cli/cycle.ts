/**
 * Runs one agent cycle against live prices from the Agent API token list,
 * on a simulated portfolio. No funds move.
 *
 *   pnpm cycle "I want some NEAR exposure without much risk"
 *   pnpm cycle --propose "..."
 */
import OpenAI from "openai";
import { runCycle } from "../core/loop.js";
import { SimulatedPortfolio, type PricedToken } from "../core/portfolio.js";
import { NearAiBrain } from "../brains/nearai.js";
import { buildPolicy } from "../policy/build.js";
import { describePolicy } from "../policy/preview.js";

const USDC_BASE = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
const USDT_NEAR = "nep141:usdt.tether-token.near";
const WNEAR = "nep141:wrap.near";

async function fetchTokens(baseUrl: string): Promise<PricedToken[]> {
  const res = await fetch(new URL("/v1/tokens", baseUrl), { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`GET /v1/tokens failed with HTTP ${res.status}`);
  const body = (await res.json()) as { data: PricedToken[] };
  return body.data;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const mode = args.includes("--propose") ? "propose" : "execute";
  const goal = args.filter((a) => a !== "--propose").join(" ").trim();
  if (!goal) {
    console.error('Usage: pnpm cycle [--propose] "<goal in plain words>"');
    process.exit(2);
  }
  if (!process.env.NEAR_AI_API_KEY) {
    console.error("NEAR_AI_API_KEY is not set in .env");
    process.exit(2);
  }
  const brain = NearAiBrain.fromApiKey(process.env.NEAR_AI_API_KEY);

  const baseUrl = process.env.NEAR_INTENTS_AGENT_API_URL ?? "https://api.demo.agentsonintents.com";
  const tokens = await fetchTokens(baseUrl);

  const policy = buildPolicy({
    actions: ["swap"],
    assets: [
      { assetId: USDC_BASE, symbol: "USDC", decimals: 6, perTransaction: "25" },
      { assetId: USDT_NEAR, symbol: "USDT", decimals: 6, perTransaction: "25" },
      { assetId: WNEAR, symbol: "wNEAR", decimals: 24 },
    ],
    budget: { dailyUsd: "40" },
  });
  const portfolio = new SimulatedPortfolio(tokens, { [USDC_BASE]: 100_000_000n, [WNEAR]: 0n });

  console.log("Policy (signed by the owner):");
  for (const line of describePolicy(policy, tokens)) console.log(`  ${line}`);
  console.log(`\nGoal: ${goal}\nMode: ${mode} (simulated portfolio, live prices)\nBrain: ${brain.name}\n`);

  const result = await runCycle({ brain, goal, policy, portfolio, mode });

  for (const turn of result.history) {
    if (turn.role === "assistant") {
      for (const call of turn.toolCalls) console.log(`> ${call.name} ${JSON.stringify(call.input)}`);
    } else if (turn.role === "tool_results") {
      for (const r of turn.results) console.log(`  ${r.isError ? "ERROR " : ""}${r.content.slice(0, 300)}`);
    }
  }
  const responseIds = result.history.flatMap((t) => (t.role === "assistant" && t.audit ? [t.audit.responseId] : []));
  if (responseIds.length > 0) console.log(`\nResponse ids (signed by the provider): ${responseIds.join(", ")}`);
  console.log(`\nEvents: ${JSON.stringify(result.events)}`);
  console.log(`Stop: ${result.stopReason}\n\nReport:\n${result.report}`);
  console.log(`\nPortfolio after: ${JSON.stringify(portfolio.holdings())}`);
}

main().catch((error: unknown) => {
  if (error instanceof OpenAI.AuthenticationError) console.error("NEAR AI rejected the API key (401).");
  else if (error instanceof OpenAI.RateLimitError) console.error("NEAR AI rate limit (429), try again later.");
  else if (error instanceof OpenAI.APIError) console.error(`NEAR AI API error ${error.status}`);
  else console.error(error instanceof Error ? error.message : "unexpected error");
  process.exit(1);
});
