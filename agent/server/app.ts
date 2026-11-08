import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import type { Policy } from "@near-intents-agent-api/sdk";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import { z } from "zod";
import { emptySpendState, type SpendState } from "../core/guard.js";
import { runCycle } from "../core/loop.js";
import type { PricedToken, SimulatedPortfolio } from "../core/portfolio.js";
import type { AgentEvent } from "../core/tools.js";
import type { Brain } from "../core/types.js";
import { bearerToken, type TokenVerifier } from "./auth.js";
import { LIMITS } from "./config.js";
import { DailyQuota } from "./quota.js";

export interface AppDeps {
  verify: TokenVerifier;
  brain: Brain;
  tokens: () => Promise<PricedToken[]>;
  policy: () => Policy;
  newPortfolio: (tokens: readonly PricedToken[]) => SimulatedPortfolio;
  allowedOrigins: string[];
  agentEnabled: boolean;
  trustedProxy: string | null;
  quota?: DailyQuota;
  logger?: boolean;
}

interface UserState {
  portfolio: SimulatedPortfolio;
  spend: SpendState;
}

const chatBody = z.strictObject({ message: z.string().trim().min(1).max(LIMITS.messageChars) });

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
  }
}

/**
 * The agent HTTP API. One route that matters: POST /api/chat runs one agent cycle
 * for the signed-in Privy user on their own simulated portfolio.
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
  await app.register(rateLimit, { max: LIMITS.requestsPerIpPerMinute, timeWindow: "1 minute" });

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
      const result = await runCycle({
        brain: deps.brain,
        goal: body.data.message,
        policy: deps.policy(),
        portfolio: state.portfolio,
        spend: state.spend,
        mode: "execute",
      });
      for (const e of result.events) req.log.info({ userId, event: e.type, ...("code" in e ? { code: e.code } : {}) }, "agent_event");
      return {
        simulated: true,
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
