/**
 * Starts the agent API. Settings come from the environment (see .env.example):
 *
 *   pnpm server
 */
import { dirname, join } from "node:path";
import { NEAR_AI_MODEL, NearAiBrain } from "../brains/nearai.js";
import { attestModel, liveAttestationDeps } from "./attestation.js";
import { proveReply } from "./replyProof.js";
import { demoPolicy, demoPortfolio, fetchTokens } from "../core/demo.js";
import type { PricedToken } from "../core/portfolio.js";
import { agentApiAccounts } from "./agents.js";
import { buildApp } from "./app.js";
import { partnerQuoteAgent } from "./dryRun.js";
import { agentApiView, dashboard } from "./dashboard.js";
import { privyVerifier } from "./auth.js";
import { LIMITS, loadConfig } from "./config.js";
import { fileGrantStore, grantKey } from "./grants.js";
import { agentApiPort, loadIntiKey, nearChain } from "./orders.js";
import { fileSpendLog } from "./spendLog.js";
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
  const chain = nearChain(config.nearRpcUrl, await loadIntiKey(config.intiKeyFile, config.intiPublicKey));
  // Next to the grants, so it lives wherever the server already keeps its state.
  const spendLog = await fileSpendLog(join(dirname(config.grantFile), "agent-spend.json"));
  const agentPort = agentApiPort(config.agentApiKey, config.agentApiUrl);
  const orders = trading({ agents, grants, chain, agent: agentPort, tokens, spendLog });

  // What an agent holds goes back to its owner's wallet: at start, then every few minutes.
  let sweeping = false;
  const sweepNow = async () => {
    if (sweeping) return;
    sweeping = true;
    try {
      for (const { userId, sent, stuck, error } of await orders.sweepAll(grants.users())) {
        if (sent.length > 0) app.log.info({ userId, assets: sent.length }, "agent_swept");
        // Money that stays on an agent is never silent: each round says what and why.
        if (stuck.length > 0 || error) app.log.warn({ userId, stuck, error }, "agent_sweep_stuck");
      }
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
    attest: () => attestModel(NEAR_AI_MODEL, liveAttestationDeps),
    proveReply: (model, calls, attestedKey) =>
      proveReply(model, calls, { fetch, apiKey: config.nearAiApiKey, attestedKey, wait: (ms) => new Promise((r) => setTimeout(r, ms)), now: Date.now }),
    policy: demoPolicy,
    newPortfolio: demoPortfolio,
    dryRun: { quoteAgent: partnerQuoteAgent(config.agentApiKey, config.agentApiUrl), agent: agentPort },
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
