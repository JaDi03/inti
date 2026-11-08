/**
 * Starts the agent API. Settings come from the environment (see .env.example):
 *
 *   pnpm server
 */
import { NearAiBrain } from "../brains/nearai.js";
import { demoPolicy, demoPortfolio, fetchTokens } from "../core/demo.js";
import type { PricedToken } from "../core/portfolio.js";
import { buildApp } from "./app.js";
import { privyVerifier } from "./auth.js";
import { LIMITS, loadConfig } from "./config.js";

async function main(): Promise<void> {
  const config = loadConfig(process.env);

  let cached: { at: number; tokens: PricedToken[] } | null = null;
  const tokens = async (): Promise<PricedToken[]> => {
    if (cached && Date.now() - cached.at < LIMITS.tokensTtlMs) return cached.tokens;
    cached = { at: Date.now(), tokens: await fetchTokens(config.agentApiUrl) };
    return cached.tokens;
  };

  const app = await buildApp({
    verify: await privyVerifier(config.privyAppId, config.privyVerificationKey),
    brain: NearAiBrain.fromApiKey(config.nearAiApiKey),
    tokens,
    policy: demoPolicy,
    newPortfolio: demoPortfolio,
    allowedOrigins: config.allowedOrigins,
    agentEnabled: config.agentEnabled,
    trustedProxy: config.trustedProxy,
  });
  await app.listen({ host: config.host, port: config.port });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "server failed to start");
  process.exit(1);
});
