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
import { AgentsUnavailableError, type AgentAccounts } from "./agents.js";
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
  now?: () => number;
  policy: () => Policy;
  newPortfolio: (tokens: readonly PricedToken[]) => SimulatedPortfolio;
  allowedOrigins: string[];
  agentEnabled: boolean;
  trustedProxy: string | null;
  quota?: DailyQuota;
  agentQuota?: DailyQuota;
  logger?: boolean;
}

interface UserState {
  portfolio: SimulatedPortfolio;
  spend: SpendState;
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

  // The document the user's wallet signs so Inti's server may trade for their agent.
  app.post("/api/agent/grant/prepare", async (req, reply) => {
    const userId = await signedInUser(req, reply);
    if (userId === null) return reply;
    const choice = prepareGrantBody.safeParse(req.body ?? {});
    if (!choice.success) return reply.code(400).send({ error: "bad_request" });
    try {
      const agent = await deps.agents.find(userId);
      if (agent.status !== "active") return reply.code(409).send({ error: "no_agent" });
      const allowed = grantQuota.take(userId);
      if (allowed !== "ok") {
        req.log.warn({ userId, cap: allowed }, "grant_quota_refused");
        return reply.code(429).send({ error: "rate_limited" });
      }
      const { token, expiresAt, body } = newGrantRequest(agent.agentId, now(), choice.data.days);
      // Read before the new grant exists, so only the earlier ones are ever closed.
      const revokes = await deps.agents.prepareRevokes(agent.agentId);
      const prepared = await deps.agents.prepareGrant(body);
      remember(pendingGrants, prepared.correlationId, { userId, record: { agentId: agent.agentId, token, expiresAt } });
      for (const r of revokes) remember(pendingRevokes, r.correlationId, { userId, grant: prepared.correlationId });
      req.log.info({ userId, days: choice.data.days ?? GRANT_DAYS, revokes: revokes.length }, "grant_prepared");
      return { status: "pending_signature", correlationId: prepared.correlationId, intent: prepared.intent, preview: prepared.preview, expiresAt, revokes };
    } catch (error) {
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
    try {
      const agent = await deps.agents.find(userId);
      if (agent.status !== "active") return reply.code(409).send({ error: "no_agent" });
      const allowed = policyQuota.take(userId);
      if (allowed !== "ok") {
        req.log.warn({ userId, cap: allowed }, "policy_quota_refused");
        return reply.code(429).send({ error: "rate_limited" });
      }
      const prepared = await deps.agents.preparePolicy(agent.agentId, agent.ownerAccount, body.data.maxDeviationBps);
      if (prepared.status === "cooldown") return reply.code(409).send({ error: "cooldown", availableAt: prepared.availableAt });
      if (pendingPolicies.size >= LIMITS.pendingPolicyChangesInMemory) {
        const oldest = pendingPolicies.keys().next().value;
        if (oldest !== undefined) pendingPolicies.delete(oldest);
      }
      pendingPolicies.set(prepared.correlationId, userId);
      req.log.info({ userId, bps: body.data.maxDeviationBps }, "policy_prepared");
      return prepared;
    } catch (error) {
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
      if (outcome !== "processing") pendingPolicies.delete(body.data.correlationId);
      req.log.info({ userId, outcome }, "policy_submitted");
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
        state = { portfolio: deps.newPortfolio(tokens), spend: emptySpendState() };
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
      });
      for (const e of result.events) req.log.info({ userId, event: e.type, ...("code" in e ? { code: e.code } : {}) }, "agent_event");
      return {
        simulated: tools === null,
        report: result.report,
        stopReason: result.stopReason,
        events: result.events.map(publicEvent),
        responseIds: result.history.flatMap((t) => (t.role === "assistant" && t.audit ? [t.audit.responseId] : [])),
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
