import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import type { Policy } from "@near-intents-agent-api/sdk";
import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import { emptySpendState, type SpendState } from "../core/guard.js";
import { runCycle, type Toolset } from "../core/loop.js";
import type { PricedToken, SimulatedPortfolio } from "../core/portfolio.js";
import type { AgentEvent } from "../core/tools.js";
import type { Brain } from "../core/types.js";
import { PRICE_PROTECTION_BPS } from "../policy/agentPolicy.js";
import { HELD_ASSETS, HELD_KEYS } from "../policy/heldAssets.js";
import { fromAtomic } from "../policy/units.js";
import { AgentsUnavailableError, type AgentAccounts } from "./agents.js";
import type { ModelAttestation } from "./attestation.js";
import { ProofStore, type ReplyProof, type SignedCall } from "./replyProof.js";
import { bearerToken, type TokenVerifier } from "./auth.js";
import type { Dashboard } from "./dashboard.js";
import { LIMITS } from "./config.js";
import { GRANT_DAY_CHOICES, GRANT_DAYS, newGrantRequest, usableGrant, type GrantRecord, type GrantStore } from "./grants.js";
import type { ChainPort } from "./orders.js";
import { DailyQuota } from "./quota.js";
import { realTools } from "./realTools.js";
import type { Trading } from "./trading.js";

export interface AppDeps {
  verify: TokenVerifier;
  brain: Brain;
  tokens: () => Promise<PricedToken[]>;
  agents: AgentAccounts;
  grants: GrantStore;
  /** Real orders. Without them every chat runs on the simulated portfolio. */
  trading?: Trading;
  chain?: ChainPort;
  /** The signed-in user's dashboard: prices, and their own agent's rules and open orders. */
  dashboard?: Dashboard;
  /** Checks, with a fresh nonce, that the model behind the chat runs in attested hardware. */
  attest?: () => Promise<ModelAttestation>;
  /** Checks that the model calls behind one reply were signed by the attested key. */
  proveReply?: (model: string, calls: SignedCall[], attestedKey: () => Promise<string | null>) => Promise<ReplyProof>;
  now?: () => number;
  policy: () => Policy;
  newPortfolio: (tokens: readonly PricedToken[]) => SimulatedPortfolio;
  allowedOrigins: string[];
  agentEnabled: boolean;
  trustedProxy: string | null;
  quota?: DailyQuota;
  agentQuota?: DailyQuota;
  verifyQuota?: DailyQuota;
  heldSaleQuota?: DailyQuota;
  logger?: boolean;
}

interface UserState {
  portfolio: SimulatedPortfolio;
  spend: SpendState;
  /** This user's latest exchanges, oldest first, so the model can follow up on them. Kept in memory only. */
  recent: { user: string; reply: string }[];
}

const chatBody = z.strictObject({ message: z.string().trim().min(1).max(LIMITS.messageChars) });
/** The owner is the user's implicit NEAR account and its ed25519 key. */
const prepareAgentBody = z.strictObject({
  accountId: z.string().regex(/^[0-9a-f]{64}$/),
  publicKey: z.string().regex(/^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/),
});
/** How long the new grant lasts; without a choice, the default. */
const prepareGrantBody = z.strictObject({ days: z.literal(GRANT_DAY_CHOICES).optional() });
const preparePolicyBody = z.strictObject({
  maxDeviationBps: z.literal(PRICE_PROTECTION_BPS),
});
/** Whether the owner freezes (true) or unfreezes (false) their agent. */
const prepareFreezeBody = z.strictObject({ frozen: z.boolean() });
/** Which asset the agent keeps to sell; always all of it. */
const sellHeldBody = z.strictObject({ asset: z.enum(HELD_KEYS) });
const submitAgentBody = z.strictObject({
  correlationId: z.string().min(1).max(128),
  signedData: z.record(z.string(), z.unknown()),
});

/** Only these fields leave the server, whatever the event holds. */
function publicEvent(e: AgentEvent): Record<string, string> {
  switch (e.type) {
    case "swap_executed":
    case "swap_proposed":
      return { type: e.type, from: e.from, to: e.to, amountIn: e.amountIn, amountOut: e.amountOut, usd: e.usd, reason: e.reason };
    case "swap_denied":
      return { type: e.type, from: e.from, amountIn: e.amountIn, code: e.code, reason: e.reason };
    case "question":
      return { type: e.type, text: e.text };
    case "limit_order_placed":
      return { type: e.type, to: e.to, usd: e.usd, priceUsd: e.priceUsd, days: e.days };
  }
}

/**
 * The agent HTTP API. POST /api/chat runs one agent cycle for the signed-in Privy user on
 * their own simulated portfolio; the /api/agent routes create that user's own agent.
 */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    bodyLimit: LIMITS.bodyBytes,
    trustProxy: deps.trustedProxy ?? false,
    logger: deps.logger === false ? false : { redact: ["req.headers.authorization"] },
  });
  const quota = deps.quota ?? new DailyQuota(LIMITS.cyclesPerUserPerDay, LIMITS.cyclesPerDayTotal);
  const users = new Map<string, UserState>();
  const busy = new Set<string>();
  const agentQuota = deps.agentQuota ?? new DailyQuota(LIMITS.agentsPerUserPerDay, LIMITS.agentsPerDayTotal);
  // Agent creations waiting for a signature, and the user each one belongs to.
  const pendingAgents = new Map<string, string>();
  const now = deps.now ?? Date.now;
  const grantQuota = new DailyQuota(LIMITS.grantsPerUserPerDay, LIMITS.grantsPerDayTotal);
  // Grants waiting for a signature: the user, and the token that only the server ever holds.
  const pendingGrants = new Map<string, { userId: string; record: GrantRecord }>();
  // Closings of earlier grants, each tied to the new grant that must be live before it is sent.
  const pendingRevokes = new Map<string, { userId: string; grant: string }>();
  // New grants that went live, and their user.
  const issuedGrants = new Map<string, string>();
  /** Keeps a pending entry, dropping the oldest when the map is full. */
  const remember = <T>(map: Map<string, T>, key: string, value: T) => {
    if (map.size >= LIMITS.pendingGrantsInMemory) {
      const oldest = map.keys().next().value;
      if (oldest !== undefined) map.delete(oldest);
    }
    map.set(key, value);
  };
  const policyQuota = new DailyQuota(LIMITS.policyChangesPerUserPerDay, LIMITS.policyChangesPerDayTotal);
  // Rule changes waiting for a signature, and the user each one belongs to.
  const pendingPolicies = new Map<string, string>();
  // Freezes and unfreezes waiting for the owner's signature, the user each one belongs to and which it is.
  const pendingFreezes = new Map<string, { userId: string; type: "agent_freeze" | "agent_unfreeze" }>();
  const verifyQuota = deps.verifyQuota ?? new DailyQuota(LIMITS.verificationsPerUserPerDay, LIMITS.verificationsPerDayTotal);
  let verifying = 0;
  let lastAttestation: { at: number; result: ModelAttestation } | null = null;
  let sharedAttestation: Promise<ModelAttestation> | null = null;
  const proofs = new ProofStore(LIMITS.proofsInMemory);
  const proofQuota = new DailyQuota(LIMITS.proofsPerUserPerDay, LIMITS.proofsPerDayTotal);
  const heldSaleQuota = deps.heldSaleQuota ?? new DailyQuota(LIMITS.heldSalesPerUserPerDay, LIMITS.heldSalesPerDayTotal);

  // JSON only: nothing may load from or frame these responses.
  await app.register(helmet, {
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    frameguard: { action: "deny" },
  });
  await app.register(cors, {
    origin: deps.allowedOrigins,
    methods: ["GET", "POST"],
    allowedHeaders: ["Authorization", "Content-Type"],
  });
  // The browser's CORS preflight comes with every call; it reaches no handler, so it does not count.
  await app.register(rateLimit, { max: LIMITS.requestsPerIpPerMinute, timeWindow: "1 minute", allowList: (req) => req.method === "OPTIONS" });

  app.addHook("onSend", async (_req, reply) => {
    reply.header("Cache-Control", "no-store");
  });
  // Generic errors only: no stack traces or upstream details reach the client.
  app.setErrorHandler((error: FastifyError, req, reply) => {
    const status = typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500;
    if (status >= 500) req.log.error({ err: error.message }, "request failed");
    void reply.code(status).send({ error: status === 413 ? "too_large" : status === 429 ? "rate_limited" : status >= 500 ? "server_error" : "bad_request" });
  });

  app.get("/health", async () => ({ ok: true }));

  /** The signed-in Privy user, or null after answering 401. */
  const signedInUser = async (req: FastifyRequest, reply: FastifyReply): Promise<string | null> => {
    const token = bearerToken(req.headers.authorization);
    try {
      if (!token) throw new Error("no token");
      return await deps.verify(token);
    } catch {
      req.log.warn("auth_failed");
      void reply.code(401).send({ error: "unauthorized" });
      return null;
    }
  };
  const agentFailure = (req: FastifyRequest, reply: FastifyReply, error: unknown) => {
    const code = error instanceof AgentsUnavailableError ? error.code : "agents_unavailable";
    req.log.error({ code }, "agent_api_failed");
    return reply.code(code === "agents_limit" ? 429 : 502).send({ error: code });
  };

  // The user's own agent, if they have one. The id comes from the token, never from the request.
  app.get("/api/agent", async (req, reply) => {
    const userId = await signedInUser(req, reply);
    if (userId === null) return reply;
    try {
      const agent = await deps.agents.find(userId);
      if (agent.status !== "active") return agent;
      // The token never leaves the server; the user sees only until when Inti may act.
      const grant = usableGrant(deps.grants.get(userId), now());
      const sameAgent = grant?.agentId === agent.agentId;
      return { ...agent, grant: sameAgent ? { expiresAt: grant.expiresAt } : null };
    } catch (error) {
      return agentFailure(req, reply, error);
    }
  });

  // Read only. The agent comes from the session's user, so nobody can read another user's agent.
  app.get("/api/dashboard", async (req, reply) => {
    const userId = await signedInUser(req, reply);
    if (userId === null) return reply;
    if (!deps.dashboard) return reply.code(503).send({ error: "unavailable" });
    return deps.dashboard(userId);
  });

  // Sends all the NEAR the user's agent holds to the user's wallet. Like the sale below it does not
  // go through the model, and the agent and the amount come from the session, never the request.
  app.post("/api/agent/cash/home", async (req, reply) => {
    const userId = await signedInUser(req, reply);
    if (userId === null) return reply;
    const trading = deps.trading;
    if (!trading) return reply.code(503).send({ error: "unavailable" });
    // Shares the sale's daily cap: each one is an Agent API action on the owner's agent.
    const allowed = heldSaleQuota.take(userId);
    if (allowed !== "ok") return reply.code(429).send({ error: allowed });
    try {
      const result = await trading.sendCashHome(userId);
      req.log.info({ userId, status: result.status, ...("code" in result ? { code: result.code } : {}) }, "cash_sent_home");
      if (result.status !== "done" && result.status !== "pending") heldSaleQuota.giveBack(userId);
      else deps.dashboard?.forget(userId);
      if (result.status === "done") return { status: "done", sent: fromAtomic(result.sent.toString(), 24) };
      return "code" in result ? { status: result.status, code: result.code } : { status: result.status };
    } catch (error) {
      heldSaleQuota.giveBack(userId);
      req.log.error({ userId, err: error instanceof Error ? error.message : "unknown" }, "cash_home_failed");
      return reply.code(502).send({ error: "agent_unavailable" });
    }
  });

  // Sells all of one asset the user's agent keeps, for NEAR sent to the user's wallet. It does not
  // go through the model, so the owner can always get out, even while the chat is paused. The
  // agent comes from the session and the amount from the agent's own balance, never the request.
  app.post("/api/held/sell", async (req, reply) => {
    const userId = await signedInUser(req, reply);
    if (userId === null) return reply;
    const body = sellHeldBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const trading = deps.trading;
    if (!trading) return reply.code(503).send({ error: "unavailable" });
    const allowed = heldSaleQuota.take(userId);
    if (allowed !== "ok") return reply.code(429).send({ error: allowed });
    const assetId = HELD_ASSETS[body.data.asset].assetId;
    try {
      const amount = (await trading.held(userId)).get(assetId) ?? 0n;
      if (amount === 0n) {
        heldSaleQuota.giveBack(userId);
        return { status: "refused", code: "not_enough" };
      }
      const result = await trading.sellHeld(userId, assetId, amount);
      req.log.info({ userId, asset: body.data.asset, status: result.status, ...("code" in result ? { code: result.code } : {}) }, "held_sold");
      // Only a sale that happened or is still settling counts toward the day's sales.
      if (result.status !== "done" && result.status !== "pending") heldSaleQuota.giveBack(userId);
      if (result.status === "done" || result.status === "pending") deps.dashboard?.forget(userId);
      if (result.status === "done") return { status: "done", received: fromAtomic(result.received.toString(), 24) };
      return "code" in result ? { status: result.status, code: result.code } : { status: result.status };
    } catch (error) {
      heldSaleQuota.giveBack(userId);
      req.log.error({ userId, err: error instanceof Error ? error.message : "unknown" }, "held_sale_failed");
      return reply.code(502).send({ error: "agent_unavailable" });
    }
  });

  // A check of the hardware the chat's model runs on. Public facts only; nothing about the user is
  // stored. One recent result serves everyone, so opening the app never uses up anyone's checks;
  // `?fresh=true` (the "Verify again" button) runs a new one within the user's own daily cap.
  const runAttest = async (req: FastifyRequest, attest: () => Promise<ModelAttestation>) => {
    verifying += 1;
    try {
      const result = await attest();
      lastAttestation = { at: now(), result };
      req.log.info({ ok: result.ok, failed: result.checks.filter((c) => !c.ok).map((c) => c.id) }, "model_verified");
      return result;
    } finally {
      verifying -= 1;
    }
  };
  app.get("/api/verify", async (req, reply) => {
    const userId = await signedInUser(req, reply);
    if (userId === null) return reply;
    const attest = deps.attest;
    if (!attest) return reply.code(503).send({ error: "unavailable" });
    const fresh = (req.query as Record<string, unknown> | undefined)?.fresh === "true";
    if (!fresh) return sharedAttest(req, attest);
    if (verifying >= LIMITS.verificationsAtOnce) return reply.code(503).send({ error: "busy" });
    const taken = verifyQuota.take(userId);
    if (taken !== "ok") return reply.code(429).send({ error: taken });
    return runAttest(req, attest);
  });
  /** The recent check everyone shares; one runs at a time and everyone waits for the same answer. */
  const sharedAttest = (req: FastifyRequest, attest: () => Promise<ModelAttestation>): Promise<ModelAttestation> => {
    if (lastAttestation && now() - lastAttestation.at < LIMITS.sharedVerificationMs) return Promise.resolve(lastAttestation.result);
    sharedAttestation ??= runAttest(req, attest).finally(() => (sharedAttestation = null));
    return sharedAttestation;
  };

  // Whether the model calls behind one of the user's own replies were signed by the attested key.
  app.get("/api/chat/proof/:id", async (req, reply) => {
    const userId = await signedInUser(req, reply);
    if (userId === null) return reply;
    const id = (req.params as { id?: unknown }).id;
    const entry = typeof id === "string" && /^[0-9a-f-]{36}$/.test(id) ? proofs.get(id, userId) : null;
    if (!entry) return reply.code(404).send({ error: "not_found" });
    if (entry.proof) return entry.proof;
    const { attest, proveReply } = deps;
    if (!attest || !proveReply) return reply.code(503).send({ error: "unavailable" });
    const taken = proofQuota.take(userId);
    if (taken !== "ok") return reply.code(429).send({ error: taken });
    const attestedKey = async () => {
      const result = await sharedAttest(req, attest);
      return result.ok ? result.signingAddress : null;
    };
    const proof = await proveReply(entry.model, entry.calls, attestedKey);
    // A signature not ready yet may be there on the next try; anything else is final.
    if (proof.calls.every((c) => c.failure !== "unavailable")) entry.proof = proof;
    req.log.info({ ok: proof.ok, failures: proof.calls.flatMap((c) => (c.failure ? [c.failure] : [])) }, "reply_proved");
    return proof;
  });

  // The document the user's wallet signs so Inti's server may trade for their agent.
  app.post("/api/agent/grant/prepare", async (req, reply) => {
    const userId = await signedInUser(req, reply);
    if (userId === null) return reply;
    const choice = prepareGrantBody.safeParse(req.body ?? {});
    if (!choice.success) return reply.code(400).send({ error: "bad_request" });
    let taken = false;
    try {
      const agent = await deps.agents.find(userId);
      if (agent.status !== "active") return reply.code(409).send({ error: "no_agent" });
      const allowed = grantQuota.take(userId);
      if (allowed !== "ok") {
        req.log.warn({ userId, cap: allowed }, "grant_quota_refused");
        return reply.code(429).send({ error: "rate_limited" });
      }
      taken = true;
      const { token, expiresAt, body } = newGrantRequest(agent.agentId, now(), choice.data.days);
      // Read before the new grant exists, so only the earlier ones are ever closed.
      const revokes = await deps.agents.prepareRevokes(agent.agentId);
      const prepared = await deps.agents.prepareGrant(body);
      remember(pendingGrants, prepared.correlationId, { userId, record: { agentId: agent.agentId, token, expiresAt } });
      for (const r of revokes) remember(pendingRevokes, r.correlationId, { userId, grant: prepared.correlationId });
      req.log.info({ userId, days: choice.data.days ?? GRANT_DAYS, revokes: revokes.length }, "grant_prepared");
      return { status: "pending_signature", correlationId: prepared.correlationId, intent: prepared.intent, preview: prepared.preview, expiresAt, revokes };
    } catch (error) {
      // Nothing was prepared, so the try does not count against the user or everyone else.
      if (taken) grantQuota.giveBack(userId);
      return agentFailure(req, reply, error);
    }
  });

  // Sends the signed grant. Only the user who asked for it may send it; the token is kept only once it is live.
  app.post("/api/agent/grant/submit", { bodyLimit: LIMITS.agentBodyBytes }, async (req, reply) => {
    const userId = await signedInUser(req, reply);
    if (userId === null) return reply;
    const body = submitAgentBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const pending = pendingGrants.get(body.data.correlationId);
    if (pending?.userId !== userId) return reply.code(404).send({ error: "not_found" });
    try {
      const outcome = await deps.agents.submit(body.data.correlationId, body.data.signedData, "grant_issue");
      if (outcome === "success") {
        await deps.grants.put(userId, pending.record);
        remember(issuedGrants, body.data.correlationId, userId);
        deps.dashboard?.forget(userId);
      }
      if (outcome !== "processing") pendingGrants.delete(body.data.correlationId);
      req.log.info({ userId, outcome }, "grant_submitted");
      return outcome === "success" ? { status: outcome, expiresAt: pending.record.expiresAt } : { status: outcome };
    } catch (error) {
      return agentFailure(req, reply, error);
    }
  });

  // Closes one earlier grant. Only its user may send it, and only once the grant that replaces it is live.
  app.post("/api/agent/grant/revoke/submit", { bodyLimit: LIMITS.agentBodyBytes }, async (req, reply) => {
    const userId = await signedInUser(req, reply);
    if (userId === null) return reply;
    const body = submitAgentBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const pending = pendingRevokes.get(body.data.correlationId);
    if (pending?.userId !== userId || issuedGrants.get(pending.grant) !== userId) return reply.code(404).send({ error: "not_found" });
    try {
      const outcome = await deps.agents.submit(body.data.correlationId, body.data.signedData, "grant_revoke");
      if (outcome !== "processing") pendingRevokes.delete(body.data.correlationId);
      req.log.info({ userId, outcome }, "grant_revoked");
      return { status: outcome };
    } catch (error) {
      return agentFailure(req, reply, error);
    }
  });

  // The document the user's wallet signs to set their price protection. Only the percentage comes
  // from the request; the rest of the rules are rebuilt here for the session's own agent.
  app.post("/api/agent/policy/prepare", async (req, reply) => {
    const userId = await signedInUser(req, reply);
    if (userId === null) return reply;
    const body = preparePolicyBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    let taken = false;
    try {
      const agent = await deps.agents.find(userId);
      if (agent.status !== "active") return reply.code(409).send({ error: "no_agent" });
      const allowed = policyQuota.take(userId);
      if (allowed !== "ok") {
        req.log.warn({ userId, cap: allowed }, "policy_quota_refused");
        return reply.code(429).send({ error: "rate_limited" });
      }
      taken = true;
      const prepared = await deps.agents.preparePolicy(agent.agentId, agent.ownerAccount, body.data.maxDeviationBps);
      if (prepared.status === "cooldown") {
        // NEAR Intents is still waiting between changes: nothing was prepared, so the try does not count.
        policyQuota.giveBack(userId);
        return reply.code(409).send({ error: "cooldown", availableAt: prepared.availableAt });
      }
      if (pendingPolicies.size >= LIMITS.pendingPolicyChangesInMemory) {
        const oldest = pendingPolicies.keys().next().value;
        if (oldest !== undefined) pendingPolicies.delete(oldest);
      }
      pendingPolicies.set(prepared.correlationId, userId);
      req.log.info({ userId, bps: body.data.maxDeviationBps }, "policy_prepared");
      return prepared;
    } catch (error) {
      if (taken) policyQuota.giveBack(userId);
      return agentFailure(req, reply, error);
    }
  });

  // Sends the signed rule change. Only the user who asked for it may send it.
  app.post("/api/agent/policy/submit", { bodyLimit: LIMITS.agentBodyBytes }, async (req, reply) => {
    const userId = await signedInUser(req, reply);
    if (userId === null) return reply;
    const body = submitAgentBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    if (pendingPolicies.get(body.data.correlationId) !== userId) return reply.code(404).send({ error: "not_found" });
    try {
      const outcome = await deps.agents.submit(body.data.correlationId, body.data.signedData, "policy_update");
      if (outcome === "success") deps.dashboard?.forget(userId);
      if (outcome !== "processing") pendingPolicies.delete(body.data.correlationId);
      req.log.info({ userId, outcome }, "policy_submitted");
      return { status: outcome };
    } catch (error) {
      return agentFailure(req, reply, error);
    }
  });

  // The document the user's wallet signs to freeze or unfreeze their own agent. Only that choice
  // comes from the request: the agent is the session's own, and nothing happens until the user
  // signs and sends it.
  app.post("/api/agent/freeze/prepare", async (req, reply) => {
    const userId = await signedInUser(req, reply);
    if (userId === null) return reply;
    const body = prepareFreezeBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    let taken = false;
    try {
      const agent = await deps.agents.find(userId);
      if (agent.status !== "active") return reply.code(409).send({ error: "no_agent" });
      const allowed = policyQuota.take(userId);
      if (allowed !== "ok") {
        req.log.warn({ userId, cap: allowed }, "freeze_quota_refused");
        return reply.code(429).send({ error: "rate_limited" });
      }
      taken = true;
      const prepared = await deps.agents.prepareFreeze(agent.agentId, body.data.frozen);
      if (prepared.status === "cooldown") {
        // Nothing was prepared, so the try does not count.
        policyQuota.giveBack(userId);
        return reply.code(409).send({ error: "cooldown", availableAt: prepared.availableAt });
      }
      if (prepared.status !== "pending_signature") {
        policyQuota.giveBack(userId);
        return prepared;
      }
      remember(pendingFreezes, prepared.correlationId, { userId, type: body.data.frozen ? "agent_freeze" : "agent_unfreeze" });
      req.log.info({ userId, frozen: body.data.frozen }, "freeze_prepared");
      return prepared;
    } catch (error) {
      if (taken) policyQuota.giveBack(userId);
      return agentFailure(req, reply, error);
    }
  });

  // Sends the signed freeze or unfreeze. Only the user who asked for it may send it.
  app.post("/api/agent/freeze/submit", { bodyLimit: LIMITS.agentBodyBytes }, async (req, reply) => {
    const userId = await signedInUser(req, reply);
    if (userId === null) return reply;
    const body = submitAgentBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const pending = pendingFreezes.get(body.data.correlationId);
    if (pending?.userId !== userId) return reply.code(404).send({ error: "not_found" });
    try {
      const outcome = await deps.agents.submit(body.data.correlationId, body.data.signedData, pending.type);
      if (outcome === "success") deps.dashboard?.forget(userId);
      if (outcome !== "processing") pendingFreezes.delete(body.data.correlationId);
      req.log.info({ userId, outcome }, "freeze_submitted");
      return { status: outcome };
    } catch (error) {
      return agentFailure(req, reply, error);
    }
  });

  // Asks the Agent API for the document the user's wallet signs to create their agent.
  app.post("/api/agent/prepare", async (req, reply) => {
    const userId = await signedInUser(req, reply);
    if (userId === null) return reply;
    const body = prepareAgentBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    try {
      const existing = await deps.agents.find(userId);
      if (existing.status === "active") return existing;
      const allowed = agentQuota.take(userId);
      if (allowed !== "ok") {
        req.log.warn({ userId, cap: allowed }, "agent_quota_refused");
        return reply.code(429).send({ error: "agents_limit" });
      }
      const prepared = await deps.agents.prepare(userId, body.data);
      if (pendingAgents.size >= LIMITS.pendingAgentsInMemory) {
        const oldest = pendingAgents.keys().next().value;
        if (oldest !== undefined) pendingAgents.delete(oldest);
      }
      pendingAgents.set(prepared.correlationId, userId);
      req.log.info({ userId }, "agent_prepared");
      return { status: "pending_signature", ...prepared };
    } catch (error) {
      return agentFailure(req, reply, error);
    }
  });

  // Sends the user's signature to the Agent API. Only the user who asked for the document may send it.
  app.post("/api/agent/submit", { bodyLimit: LIMITS.agentBodyBytes }, async (req, reply) => {
    const userId = await signedInUser(req, reply);
    if (userId === null) return reply;
    const body = submitAgentBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    if (pendingAgents.get(body.data.correlationId) !== userId) return reply.code(404).send({ error: "not_found" });
    try {
      const outcome = await deps.agents.submit(body.data.correlationId, body.data.signedData);
      if (outcome === "success") deps.dashboard?.forget(userId);
      if (outcome !== "processing") pendingAgents.delete(body.data.correlationId);
      req.log.info({ userId, outcome }, "agent_submitted");
      return { status: outcome };
    } catch (error) {
      return agentFailure(req, reply, error);
    }
  });

  /** The real-money tools for this user, or null when they have no agent, no live grant, or trading is off. */
  const realToolsFor = async (userId: string): Promise<Toolset | null> => {
    if (!deps.trading || !deps.chain) return null;
    const agent = await deps.agents.find(userId);
    if (agent.status !== "active") return null;
    const grant = usableGrant(deps.grants.get(userId), now());
    if (grant?.agentId !== agent.agentId) return null;
    return realTools({ userId, owner: agent.ownerAccount, trading: deps.trading, chain: deps.chain, tokens: deps.tokens });
  };

  app.post("/api/chat", async (req, reply) => {
    const token = bearerToken(req.headers.authorization);
    let userId: string;
    try {
      if (!token) throw new Error("no token");
      userId = await deps.verify(token);
    } catch {
      req.log.warn("auth_failed");
      return reply.code(401).send({ error: "unauthorized" });
    }

    const body = chatBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    if (!deps.agentEnabled) return reply.code(503).send({ error: "agent_paused" });

    // One cycle at a time per user, marked before any await so two requests cannot both pass.
    if (busy.has(userId)) return reply.code(409).send({ error: "busy" });
    busy.add(userId);
    try {
      const allowed = quota.take(userId);
      if (allowed !== "ok") {
        req.log.warn({ userId, cap: allowed }, "quota_refused");
        return reply.code(429).send({ error: allowed });
      }

      let tokens: PricedToken[];
      try {
        tokens = await deps.tokens();
      } catch (error) {
        req.log.error({ err: error instanceof Error ? error.message : "unknown" }, "tokens_unavailable");
        return reply.code(502).send({ error: "agent_unavailable" });
      }
      let state = users.get(userId);
      if (!state) {
        if (users.size >= LIMITS.usersInMemory) {
          const oldest = users.keys().next().value;
          if (oldest !== undefined) users.delete(oldest);
        }
        state = { portfolio: deps.newPortfolio(tokens), spend: emptySpendState(), recent: [] };
      }
      users.delete(userId);
      users.set(userId, state);
      // Real money only for a user with their own agent and a live grant for it; everyone else gets the simulation.
      const tools = await realToolsFor(userId);
      const result = await runCycle({
        brain: deps.brain,
        goal: body.data.message,
        policy: deps.policy(),
        portfolio: state.portfolio,
        spend: state.spend,
        mode: "execute",
        ...(tools ? { tools } : {}),
        earlier: state.recent,
      });
      // Only a finished reply joins the chat's memory, cut to a bounded size.
      if (result.report !== "") {
        state.recent = [...state.recent, { user: body.data.message, reply: result.report.slice(0, LIMITS.contextReplyChars) }].slice(-LIMITS.contextExchanges);
      }
      for (const e of result.events) req.log.info({ userId, event: e.type, ...("code" in e ? { code: e.code } : {}) }, "agent_event");
      // A real trade changes what the agent holds, so the next dashboard read shows it at once.
      if (tools && result.events.some((e) => e.type === "swap_executed")) deps.dashboard?.forget(userId);
      // Every model call of this reply, with the hashes NEAR AI signs; the reply can be checked only if all have them.
      const audits = result.history.flatMap((t) => (t.role === "assistant" && t.audit ? [t.audit] : []));
      const calls = audits.flatMap((a) => (a.requestHash && a.responseHash ? [{ responseId: a.responseId, requestHash: a.requestHash, responseHash: a.responseHash }] : []));
      const model = audits[0]?.model;
      // Only a reply whose words came from the model can carry its signature: a run cut at max_steps has none.
      const fromModel = result.stopReason !== "max_steps" && result.report !== "";
      const proofId = deps.proveReply && fromModel && model && calls.length > 0 && calls.length === audits.length ? proofs.remember(userId, model, calls) : null;
      return {
        simulated: tools === null,
        report: result.report,
        stopReason: result.stopReason,
        events: result.events.map(publicEvent),
        responseIds: audits.map((a) => a.responseId),
        proofId,
      };
    } catch (error) {
      req.log.error({ userId, err: error instanceof Error ? error.message : "unknown" }, "cycle_failed");
      return reply.code(502).send({ error: "agent_unavailable" });
    } finally {
      busy.delete(userId);
    }
  });

  return app;
}
