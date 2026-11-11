/**
 * Starts the agent API. Settings come from the environment (see .env.example):
 *
 *   pnpm server
 */
import { NearAiBrain } from "../brains/nearai.js";
import { demoPolicy, demoPortfolio, fetchTokens } from "../core/demo.js";
import type { PricedToken } from "../core/portfolio.js";
import { agentApiAccounts } from "./agents.js";
import { buildApp } from "./app.js";
import { agentApiView, dashboard } from "./dashboard.js";
import { privyVerifier } from "./auth.js";
import { LIMITS, loadConfig } from "./config.js";
import { fileGrantStore, grantKey } from "./grants.js";
import { agentApiPort, loadIntiKey, nearChain } from "./orders.js";
import { trading } from "./trading.js";

async function main(): Promise<void> {
  const config = loadConfig(process.env);

  let cached: { at: number; tokens: PricedToken[] } | null = null;
  const tokens = async (): Promise<PricedToken[]> => {
    if (cached && Date.now() - cached.at < LIMITS.tokensTtlMs) return cached.tokens;
    cached = { at: Date.now(), tokens: await fetchTokens(config.agentApiUrl) };
    return cached.tokens;
  };

  const agents = agentApiAccounts(config.agentApiKey, config.agentApiUrl);
  const grants = await fileGrantStore(config.grantFile, grantKey(config.grantKey));
  const chain = nearChain(config.nearRpcUrl, await loadIntiKey(config.intiKeyFile));
  const orders = trading({ agents, grants, chain, agent: agentApiPort(config.agentApiKey, config.agentApiUrl), tokens });

  // What an agent holds goes back to its owner's wallet: at start, then every few minutes.
  let sweeping = false;
  const sweepNow = async () => {
    if (sweeping) return;
    sweeping = true;
    try {
      for (const { userId, sent } of await orders.sweepAll(grants.users())) app.log.info({ userId, assets: sent.length }, "agent_swept");
    } catch (error) {
      app.log.error({ err: error instanceof Error ? error.message : "unknown" }, "sweep_failed");
    } finally {
      sweeping = false;
    }
  };

  const app = await buildApp({
    verify: await privyVerifier(config.privyAppId, config.privyVerificationKey),
    brain: NearAiBrain.fromApiKey(config.nearAiApiKey),
    tokens,
    agents,
    grants,
    trading: orders,
    chain,
    dashboard: dashboard({ agents, grants, view: agentApiView(config.agentApiKey, config.agentApiUrl), tokens }),
    policy: demoPolicy,
    newPortfolio: demoPortfolio,
    allowedOrigins: config.allowedOrigins,
    agentEnabled: config.agentEnabled,
    trustedProxy: config.trustedProxy,
  });
  await app.listen({ host: config.host, port: config.port });
  void sweepNow();
  setInterval(() => void sweepNow(), LIMITS.sweepEveryMs);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "server failed to start");
  process.exit(1);
});
