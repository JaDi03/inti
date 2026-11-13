import { readFileSync } from "node:fs";
import { exportSPKI, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { ScriptedBrain } from "../brains/scripted.js";
import { demoPolicy, demoPortfolio } from "../core/demo.js";
import type { PricedToken } from "../core/portfolio.js";
import type { Brain } from "../core/types.js";
import { AgentsUnavailableError, type AgentAccounts, type AgentLookup } from "./agents.js";
import { buildApp, type AppDeps } from "./app.js";
import { bearerToken, privyVerifier, type TokenVerifier } from "./auth.js";
import { LIMITS } from "./config.js";
import type { GrantRecord, GrantStore } from "./grants.js";
import { DailyQuota } from "./quota.js";
import type { Trading } from "./trading.js";

// Real tokens and prices copied from GET /v1/tokens.
const { tokens } = JSON.parse(readFileSync(new URL("../core/fixtures/priced-tokens.json", import.meta.url), "utf8")) as {
  tokens: PricedToken[];
};
const APP_ID = "test-app";
const ORIGIN = "https://example.com";

let privateKey: CryptoKey;
let otherKey: CryptoKey;
let verify: TokenVerifier;

beforeAll(async () => {
  // Keys are generated per run: no key material lives in the repo.
  const pair = await generateKeyPair("ES256");
  privateKey = pair.privateKey;
  otherKey = (await generateKeyPair("ES256")).privateKey;
  verify = await privyVerifier(APP_ID, await exportSPKI(pair.publicKey));
});

function token(opts: { key?: CryptoKey; sub?: string; aud?: string; iss?: string; exp?: string } = {}): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256" })
    .setSubject(opts.sub ?? "did:privy:alice")
    .setIssuer(opts.iss ?? "privy.io")
    .setAudience(opts.aud ?? APP_ID)
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? "1h")
    .sign(opts.key ?? privateKey);
}

const reportOnly = (): Brain => new ScriptedBrain(Array.from({ length: 50 }, () => () => ({ text: "Done.", stop: "end" as const, toolCalls: [] })));

const OWNER = { accountId: "ab".repeat(32), publicKey: `ed25519:${"1".repeat(44)}` };

/** An Agent API stand-in that records what the server asked it for. */
function fakeAgents(existing: AgentLookup = { status: "none" }, cooldownUntil: string | null = null, earlierGrants = 0) {
  const calls: { prepared: string[]; submitted: string[]; grantBodies: Record<string, string>[]; submittedTypes: string[]; policies: unknown[][] } = {
    prepared: [],
    submitted: [],
    grantBodies: [],
    submittedTypes: [],
    policies: [],
  };
  const agents: AgentAccounts = {
    prepareRevokes: () =>
      Promise.resolve(Array.from({ length: earlierGrants }, (_, i) => ({ correlationId: `revoke_${i + 1}`, intent: { standard: "nep413" }, expiresAt: "2027-02-08T22:12:39.100Z" }))),
    preparePolicy: (agentId, ownerAccount, bps) => {
      calls.policies.push([agentId, ownerAccount, bps]);
      if (cooldownUntil) return Promise.resolve({ status: "cooldown", availableAt: cooldownUntil });
      return Promise.resolve({ status: "pending_signature", correlationId: `policy_${calls.policies.length}`, intent: { standard: "nep413", payload: {} }, preview: { summary: "p", policy: {} } });
    },
    prepareGrant: (body) => {
      calls.grantBodies.push(body);
      return Promise.resolve({ correlationId: `grant_${calls.grantBodies.length}`, intent: { standard: "nep413", payload: {} }, preview: { summary: "g" } });
    },
    find: () => Promise.resolve(existing),
    prepare: (userId, owner) => {
      calls.prepared.push(userId);
      return Promise.resolve({ correlationId: `intent_${calls.prepared.length}`, intent: { standard: "nep366", owner: owner.accountId }, preview: { summary: "s", policy: {} } });
    },
    submit: (correlationId, _signed, type = "agent_create") => {
      calls.submitted.push(correlationId);
      calls.submittedTypes.push(type);
      return Promise.resolve("success");
    },
  };
  return { agents, calls };
}

/** Grants kept in memory, for tests. */
function memoryGrants(): GrantStore & { records: Map<string, GrantRecord> } {
  const records = new Map<string, GrantRecord>();
  return {
    records,
    get: (userId) => records.get(userId) ?? null,
    users: () => [...records.keys()],
    put: (userId, record) => {
      records.set(userId, record);
      return Promise.resolve();
    },
  };
}

/** A dashboard that records whose kept copy was dropped. */
function forgetfulDashboard() {
  const forgotten: string[] = [];
  const dashboard = Object.assign(() => Promise.reject(new Error("not read in this test")), { forget: (userId: string) => void forgotten.push(userId) });
  return { dashboard, forgotten };
}

async function app(overrides: Partial<AppDeps> = {}) {
  return buildApp({
    verify,
    brain: reportOnly(),
    tokens: () => Promise.resolve(tokens),
    agents: fakeAgents().agents,
    grants: memoryGrants(),
    policy: demoPolicy,
    newPortfolio: demoPortfolio,
    allowedOrigins: [ORIGIN],
    agentEnabled: true,
    trustedProxy: null,
    logger: false,
    ...overrides,
  });
}

async function chat(server: Awaited<ReturnType<typeof app>>, auth: string | null, payload: unknown, origin = ORIGIN) {
  return server.inject({
    method: "POST",
    url: "/api/chat",
    headers: { "content-type": "application/json", origin, ...(auth ? { authorization: auth } : {}) },
    payload: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
}

describe("POST /api/chat", () => {
  it("runs a cycle for a signed-in user and returns only the public fields", async () => {
    const server = await app();
    const res = await chat(server, `Bearer ${await token()}`, { message: "How is my portfolio?" });
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json()).sort()).toEqual(["events", "proofId", "report", "responseIds", "simulated", "stopReason"]);
    expect(res.json()).toMatchObject({ simulated: true, report: "Done.", stopReason: "done" });
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(String(res.headers["content-security-policy"])).toContain("frame-ancestors 'none'");
    expect(res.headers["access-control-allow-origin"]).toBe(ORIGIN);
  });

  it("refuses a request without a token", async () => {
    const res = await chat(await app(), null, { message: "hi" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "unauthorized" });
  });

  it("refuses a token signed with another key, for another app, by another issuer or expired", async () => {
    const server = await app();
    for (const t of [
      await token({ key: otherKey }),
      await token({ aud: "other-app" }),
      await token({ iss: "evil.example" }),
      await token({ exp: "-1m" }),
      await token({ sub: "alice" }),
    ]) {
      expect((await chat(server, `Bearer ${t}`, { message: "hi" })).statusCode).toBe(401);
    }
  });

  it("refuses an unsigned token (alg none)", async () => {
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const none = `${enc({ alg: "none" })}.${enc({ sub: "did:privy:alice", iss: "privy.io", aud: APP_ID, exp: 9999999999 })}.x`;
    expect((await chat(await app(), `Bearer ${none}`, { message: "hi" })).statusCode).toBe(401);
  });

  it("refuses unknown fields, empty and oversized messages", async () => {
    const server = await app();
    const auth = `Bearer ${await token()}`;
    expect((await chat(server, auth, { message: "hi", owner: "did:privy:bob" })).statusCode).toBe(400);
    expect((await chat(server, auth, { message: "   " })).statusCode).toBe(400);
    expect((await chat(server, auth, { message: "x".repeat(1001) })).statusCode).toBe(400);
    const huge = await chat(server, auth, { message: "x".repeat(5000) });
    expect(huge.statusCode).toBe(413);
    expect(huge.json()).toEqual({ error: "too_large" });
  });

  it("stops at the per-user daily cap without blocking other users", async () => {
    const server = await app({ quota: new DailyQuota(2, 100) });
    const alice = `Bearer ${await token()}`;
    expect((await chat(server, alice, { message: "1" })).statusCode).toBe(200);
    expect((await chat(server, alice, { message: "2" })).statusCode).toBe(200);
    const third = await chat(server, alice, { message: "3" });
    expect(third.statusCode).toBe(429);
    expect(third.json()).toEqual({ error: "user_limit" });
    expect((await chat(server, `Bearer ${await token({ sub: "did:privy:bob" })}`, { message: "1" })).statusCode).toBe(200);
  });

  it("limits requests per IP per minute, without counting the browser's preflights", async () => {
    const server = await app();
    const preflight = () =>
      server.inject({ method: "OPTIONS", url: "/api/chat", headers: { origin: ORIGIN, "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type" } });
    const codes: number[] = [];
    for (let i = 0; i <= LIMITS.requestsPerIpPerMinute; i++) {
      expect((await preflight()).statusCode).toBe(204);
      codes.push((await chat(server, null, { message: "hi" })).statusCode);
    }
    expect(codes.slice(0, LIMITS.requestsPerIpPerMinute).every((c) => c === 401)).toBe(true);
    expect(codes[LIMITS.requestsPerIpPerMinute]).toBe(429);
  });

  it("keeps each user's portfolio apart", async () => {
    const swapThenReport = (): Brain =>
      new ScriptedBrain([
        () => ({
          text: "",
          stop: "tool_use",
          toolCalls: [
            {
              id: "1",
              name: "swap",
              input: {
                from_asset_id: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
                to_asset_id: "nep141:wrap.near",
                amount: "10",
                reason: "test",
              },
            },
          ],
        }),
        () => ({ text: "Bought.", stop: "end", toolCalls: [] }),
        () => ({ text: "", stop: "tool_use", toolCalls: [{ id: "2", name: "get_portfolio", input: {} }] }),
        () => ({ text: "Checked.", stop: "end", toolCalls: [] }),
      ]);
    const server = await app({ brain: swapThenReport() });
    await chat(server, `Bearer ${await token()}`, { message: "buy" });
    const bob = await chat(server, `Bearer ${await token({ sub: "did:privy:bob" })}`, { message: "look" });
    expect(bob.json()).toMatchObject({ report: "Checked.", events: [] });
  });

  it("answers 503 when the agent is paused", async () => {
    const res = await chat(await app({ agentEnabled: false }), `Bearer ${await token()}`, { message: "hi" });
    expect(res.statusCode).toBe(503);
  });

  it("does not allow other origins", async () => {
    const res = await chat(await app(), `Bearer ${await token()}`, { message: "hi" }, "https://evil.example");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("hides upstream errors from the client", async () => {
    const failing: Brain = { name: "failing", step: () => Promise.reject(new Error("upstream said: internal detail at host-a")) };
    const res = await chat(await app({ brain: failing }), `Bearer ${await token()}`, { message: "hi" });
    expect(res.statusCode).toBe(502);
    expect(res.body).toBe(JSON.stringify({ error: "agent_unavailable" }));
  });
});

describe("GET /api/dashboard", () => {
  it("answers only a signed-in user, with that user's own dashboard", async () => {
    const asked: string[] = [];
    const server = await app({
      dashboard: Object.assign(
        (userId: string) => {
          asked.push(userId);
          return Promise.resolve({ prices: { near: 3.58, bitcoin: null, ethereum: null, zcash: null, gold: null, euro: null, solana: null }, agent: null });
        },
        { forget: () => undefined },
      ),
    });
    expect((await server.inject({ method: "GET", url: "/api/dashboard", headers: { origin: ORIGIN } })).statusCode).toBe(401);
    const forged = await server.inject({ method: "GET", url: "/api/dashboard", headers: { origin: ORIGIN, authorization: `Bearer ${await token({ key: otherKey })}` } });
    expect(forged.statusCode).toBe(401);
    expect(asked).toEqual([]);
    const ok = await server.inject({ method: "GET", url: "/api/dashboard?user=did:privy:bob", headers: { origin: ORIGIN, authorization: `Bearer ${await token()}` } });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["cache-control"]).toBe("no-store");
    expect(asked).toEqual(["did:privy:alice"]);
  });
});

describe("POST /api/held/sell", () => {
  const GOLD = "nep141:eth-0x68749665ff8d2d112fa859aa293f07a622782f38.omft.near";
  /** Trading that keeps the same gold for every user and records every sale, with whose it was. */
  function heldTrading(heldGold = 254n) {
    const sales: string[] = [];
    const trading = {
      held: () => Promise.resolve(new Map([[GOLD, heldGold]])),
      sellHeld: (userId: string, asset: string, amount: bigint) => {
        sales.push(`${userId} ${asset === GOLD ? "gold" : asset} ${amount}`);
        return Promise.resolve({ status: "done", sold: amount, received: 278_524n * 10n ** 18n });
      },
    } as unknown as Trading;
    return { trading, sales };
  }
  const sell = async (server: Awaited<ReturnType<typeof app>>, auth: string | null, payload: unknown) =>
    server.inject({
      method: "POST",
      url: "/api/held/sell",
      headers: { "content-type": "application/json", origin: ORIGIN, ...(auth ? { authorization: auth } : {}) },
      payload: JSON.stringify(payload),
    });

  it("sells all the signed-in user's own gold for NEAR, even while the chat is paused", async () => {
    const { trading, sales } = heldTrading();
    const { dashboard, forgotten } = forgetfulDashboard();
    const server = await app({ trading, dashboard, agentEnabled: false });
    const res = await sell(server, `Bearer ${await token()}`, { asset: "gold" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "done", received: "0.278524" });
    expect(sales).toEqual(["did:privy:alice gold 254"]);
    expect(forgotten).toEqual(["did:privy:alice"]);
  });

  it("refuses without a valid session, an unknown asset, an amount or another user, before anything moves", async () => {
    const { trading, sales } = heldTrading();
    const server = await app({ trading });
    expect((await sell(server, null, { asset: "gold" })).statusCode).toBe(401);
    expect((await sell(server, `Bearer ${await token({ key: otherKey })}`, { asset: "gold" })).statusCode).toBe(401);
    const alice = `Bearer ${await token()}`;
    expect((await sell(server, alice, { asset: "bitcoin" })).statusCode).toBe(400);
    expect((await sell(server, alice, { asset: "gold", amount: "1" })).statusCode).toBe(400);
    expect((await sell(server, alice, { asset: "gold", userId: "did:privy:bob" })).statusCode).toBe(400);
    expect(sales).toEqual([]);
  });

  it("says there is nothing to sell without counting it, and caps sales per user per day", async () => {
    const empty = await app({ trading: heldTrading(0n).trading, heldSaleQuota: new DailyQuota(1, 100) });
    const alice = `Bearer ${await token()}`;
    expect((await sell(empty, alice, { asset: "gold" })).json()).toEqual({ status: "refused", code: "not_enough" });
    expect((await sell(empty, alice, { asset: "gold" })).json()).toEqual({ status: "refused", code: "not_enough" });
    const capped = await app({ trading: heldTrading().trading, heldSaleQuota: new DailyQuota(1, 100) });
    expect((await sell(capped, alice, { asset: "gold" })).statusCode).toBe(200);
    expect((await sell(capped, alice, { asset: "gold" })).statusCode).toBe(429);
    expect((await sell(capped, `Bearer ${await token({ sub: "did:privy:bob" })}`, { asset: "gold" })).statusCode).toBe(200);
  });

  it("answers a generic error when the agent's balance cannot be read", async () => {
    const trading = { held: () => Promise.reject(new Error("agent api answered 502 at https://upstream")) } as unknown as Trading;
    const res = await sell(await app({ trading }), `Bearer ${await token()}`, { asset: "gold" });
    expect(res.statusCode).toBe(502);
    expect(res.body).not.toContain("upstream");
  });
});

describe("GET /api/verify", () => {
  const RESULT = { model: "m", ok: true, checks: [{ id: "report" as const, ok: true }], signingAddress: "0x" + "ab".repeat(20), intelStatus: "UpToDate", checkedAt: "2026-11-13T07:00:00.000Z" };
  const get = async (server: Awaited<ReturnType<typeof app>>, auth: string | null, fresh = false) =>
    server.inject({ method: "GET", url: `/api/verify${fresh ? "?fresh=true" : ""}`, headers: { origin: ORIGIN, ...(auth ? { authorization: auth } : {}) } });

  it("answers only a signed-in user, and the browser never caches it", async () => {
    let runs = 0;
    const server = await app({ attest: () => (runs++, Promise.resolve(RESULT)) });
    expect((await get(server, null)).statusCode).toBe(401);
    expect((await get(server, `Bearer ${await token({ key: otherKey })}`, true)).statusCode).toBe(401);
    expect(runs).toBe(0);
    const ok = await get(server, `Bearer ${await token()}`);
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["cache-control"]).toBe("no-store");
    expect(ok.json()).toEqual(RESULT);
  });

  it("shares one recent check among everyone opening the app, without using their checks", async () => {
    let runs = 0;
    let clock = Date.parse("2026-11-13T07:00:00Z");
    const server = await app({ attest: () => (runs++, Promise.resolve(RESULT)), verifyQuota: new DailyQuota(0, 0), now: () => clock });
    const users = await Promise.all(["did:privy:alice", "did:privy:bob", "did:privy:carol"].map(async (sub) => `Bearer ${await token({ sub })}`));
    const answers = await Promise.all([...users, ...users].map((auth) => get(server, auth)));
    expect(answers.map((a) => a.statusCode)).toEqual(Array(6).fill(200));
    expect(runs).toBe(1);
    clock += LIMITS.sharedVerificationMs;
    expect((await get(server, users[0] ?? "")).statusCode).toBe(200);
    expect(runs).toBe(2);
  });

  it("caps fresh checks per user per day, and how many run at once", async () => {
    const server = await app({ attest: () => Promise.resolve(RESULT), verifyQuota: new DailyQuota(2, 100) });
    const auth = `Bearer ${await token()}`;
    for (let i = 0; i < 2; i++) expect((await get(server, auth, true)).statusCode).toBe(200);
    const over = await get(server, auth, true);
    expect(over.statusCode).toBe(429);
    expect(over.json()).toEqual({ error: "user_limit" });

    const releases: (() => void)[] = [];
    const slow = await app({ attest: () => new Promise((r) => releases.push(() => r(RESULT))) });
    const other = `Bearer ${await token({ sub: "did:privy:bob" })}`;
    const running = Array.from({ length: LIMITS.verificationsAtOnce }, () => get(slow, other, true));
    await new Promise((r) => setTimeout(r, 10));
    const extra = await get(slow, other, true);
    expect(extra.statusCode).toBe(503);
    expect(extra.json()).toEqual({ error: "busy" });
    releases.forEach((release) => release());
    expect((await Promise.all(running)).map((r) => r.statusCode)).toEqual(Array(LIMITS.verificationsAtOnce).fill(200));
  });
});

describe("GET /api/chat/proof/:id", () => {
  const KEY = "0x" + "fe".repeat(20);
  const ATTESTED = { model: "m", ok: true, checks: [], signingAddress: KEY, intelStatus: "UpToDate", checkedAt: "2026-11-13T08:00:00.000Z" };
  const audit = (n: number) => ({ provider: "nearai", model: "m", responseId: `chatcmpl-${n}`, requestHash: "aa".repeat(32), responseHash: "bb".repeat(32) });
  // Two model calls behind one reply: a tool call, then the answer.
  const signedBrain = () =>
    new ScriptedBrain([
      () => ({ text: "", stop: "tool_use" as const, toolCalls: [{ id: "1", name: "get_portfolio", input: {} }], audit: audit(1) }),
      () => ({ text: "Done.", stop: "end" as const, toolCalls: [], audit: audit(2) }),
    ]);
  const ask = (server: Awaited<ReturnType<typeof app>>, id: string, auth: string | null) =>
    server.inject({ method: "GET", url: `/api/chat/proof/${id}`, headers: { origin: ORIGIN, ...(auth ? { authorization: auth } : {}) } });

  it("checks only the user's own reply, every model call of it, against the attested key", async () => {
    const asked: { model: string; calls: unknown[]; key: string | null }[] = [];
    const server = await app({
      brain: signedBrain(),
      attest: () => Promise.resolve(ATTESTED),
      proveReply: async (model, calls, attestedKey) => {
        asked.push({ model, calls, key: await attestedKey() });
        return { ok: true, calls: calls.map((c) => ({ responseId: c.responseId, ok: true, failure: null })), attestedKey: KEY, checkedAt: "2026-11-13T08:00:00.000Z" };
      },
    });
    const alice = `Bearer ${await token()}`;
    const proofId = (await chat(server, alice, { message: "how much do I have?" })).json<{ proofId: string }>().proofId;
    expect(proofId).toMatch(/^[0-9a-f-]{36}$/);

    expect((await ask(server, proofId, null)).statusCode).toBe(401);
    expect((await ask(server, proofId, `Bearer ${await token({ sub: "did:privy:bob" })}`)).statusCode).toBe(404);
    expect((await ask(server, "not-an-id", alice)).statusCode).toBe(404);
    expect(asked).toEqual([]);

    const first = await ask(server, proofId, alice);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ ok: true, attestedKey: KEY });
    expect(asked).toEqual([{ model: "m", calls: [audit(1), audit(2)].map(({ responseId, requestHash, responseHash }) => ({ responseId, requestHash, responseHash })), key: KEY }]);
    // A final answer is kept, so asking again costs nothing.
    expect((await ask(server, proofId, alice)).json()).toMatchObject({ ok: true });
    expect(asked).toHaveLength(1);
  });

  it("asks again when a signature was not ready, and offers no proof for a reply without hashes", async () => {
    let tries = 0;
    const server = await app({
      brain: signedBrain(),
      attest: () => Promise.resolve(ATTESTED),
      proveReply: (_model, calls) => {
        tries++;
        return Promise.resolve({ ok: false, calls: calls.map((c) => ({ responseId: c.responseId, ok: false, failure: "unavailable" as const })), attestedKey: KEY, checkedAt: "x" });
      },
    });
    const alice = `Bearer ${await token()}`;
    const proofId = (await chat(server, alice, { message: "hi" })).json<{ proofId: string }>().proofId;
    await ask(server, proofId, alice);
    await ask(server, proofId, alice);
    expect(tries).toBe(2);

    const plain = await app({ attest: () => Promise.resolve(ATTESTED), proveReply: () => Promise.reject(new Error("unused")) });
    expect((await chat(plain, alice, { message: "hi" })).json()).toMatchObject({ proofId: null });
  });

  it("offers no proof for a run cut before the model answered, whose words the model never wrote", async () => {
    // The model keeps asking for tools until the step limit, so the reply has no text of its own.
    const endless = new ScriptedBrain(Array.from({ length: 50 }, (_, n) => () => ({ text: "", stop: "tool_use" as const, toolCalls: [{ id: `${n}`, name: "get_portfolio", input: {} }], audit: audit(n) })));
    const server = await app({ brain: endless, attest: () => Promise.resolve(ATTESTED), proveReply: () => Promise.reject(new Error("unused")) });
    const res = (await chat(server, `Bearer ${await token()}`, { message: "hi" })).json<{ stopReason: string; proofId: string | null }>();
    expect(res).toMatchObject({ stopReason: "max_steps", proofId: null });
  });
});

describe("the user's own agent", () => {
  const post = (server: Awaited<ReturnType<typeof app>>, url: string, auth: string | null, payload: unknown) =>
    server.inject({
      method: "POST",
      url,
      headers: { "content-type": "application/json", origin: ORIGIN, ...(auth ? { authorization: auth } : {}) },
      payload: JSON.stringify(payload),
    });

  it("prepares the creation for the signed-in user and lets only that user submit it", async () => {
    const { agents, calls } = fakeAgents();
    const server = await app({ agents });
    const alice = `Bearer ${await token()}`;
    const bob = `Bearer ${await token({ sub: "did:privy:bob" })}`;

    const prepared = await post(server, "/api/agent/prepare", alice, OWNER);
    expect(prepared.statusCode).toBe(200);
    expect(prepared.json()).toMatchObject({ status: "pending_signature", correlationId: "intent_1" });
    expect(calls.prepared).toEqual(["did:privy:alice"]);

    const stolen = await post(server, "/api/agent/submit", bob, { correlationId: "intent_1", signedData: {} });
    expect(stolen.statusCode).toBe(404);
    expect(calls.submitted).toEqual([]);

    const submitted = await post(server, "/api/agent/submit", alice, { correlationId: "intent_1", signedData: { standard: "nep366" } });
    expect(submitted.json()).toEqual({ status: "success" });
    expect(calls.submitted).toEqual(["intent_1"]);
  });

  it("returns the agent a user already has instead of creating another", async () => {
    const existing: AgentLookup = { status: "active", agentId: "agent_1", agentAccount: "cd".repeat(32), ownerAccount: OWNER.accountId };
    const { agents, calls } = fakeAgents(existing);
    const server = await app({ agents });
    const auth = `Bearer ${await token()}`;
    expect((await post(server, "/api/agent/prepare", auth, OWNER)).json()).toEqual(existing);
    expect(calls.prepared).toEqual([]);
    const read = await server.inject({ method: "GET", url: "/api/agent", headers: { origin: ORIGIN, authorization: auth } });
    expect(read.json()).toEqual({ ...existing, grant: null });
  });

  it("refuses requests without a token, with a malformed owner or with unknown fields", async () => {
    const { agents, calls } = fakeAgents();
    const server = await app({ agents });
    const auth = `Bearer ${await token()}`;
    expect((await post(server, "/api/agent/prepare", null, OWNER)).statusCode).toBe(401);
    expect((await server.inject({ method: "GET", url: "/api/agent" })).statusCode).toBe(401);
    expect((await post(server, "/api/agent/prepare", auth, { ...OWNER, accountId: "alice.near" })).statusCode).toBe(400);
    expect((await post(server, "/api/agent/prepare", auth, { ...OWNER, publicKey: "secp256k1:abc" })).statusCode).toBe(400);
    expect((await post(server, "/api/agent/prepare", auth, { ...OWNER, extra: 1 })).statusCode).toBe(400);
    expect((await post(server, "/api/agent/submit", auth, { correlationId: "intent_9", signedData: {} })).statusCode).toBe(404);
    expect(calls.prepared).toEqual([]);
  });

  it("stops at the per-user daily cap of creations", async () => {
    const { agents, calls } = fakeAgents();
    const server = await app({ agents, agentQuota: new DailyQuota(1, 10) });
    const auth = `Bearer ${await token()}`;
    expect((await post(server, "/api/agent/prepare", auth, OWNER)).statusCode).toBe(200);
    const second = await post(server, "/api/agent/prepare", auth, OWNER);
    expect(second.statusCode).toBe(429);
    expect(second.json()).toEqual({ error: "agents_limit" });
    expect(calls.prepared).toHaveLength(1);
  });

  it("hides Agent API failures behind one short code", async () => {
    const agents: AgentAccounts = {
      find: () => Promise.reject(new AgentsUnavailableError("agents_unavailable")),
      prepare: () => Promise.reject(new Error("unused")),
      submit: () => Promise.reject(new Error("unused")),
      prepareGrant: () => Promise.reject(new Error("unused")),
      preparePolicy: () => Promise.reject(new Error("unused")),
      prepareRevokes: () => Promise.reject(new Error("unused")),
    };
    const server = await app({ agents });
    const res = await post(server, "/api/agent/prepare", `Bearer ${await token()}`, OWNER);
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: "agents_unavailable" });
  });
});

describe("/api/agent/grant", () => {
  const ACTIVE: AgentLookup = { status: "active", agentId: "agent_1", agentAccount: "cd".repeat(32), ownerAccount: OWNER.accountId };
  const NOW = Date.parse("2026-11-10T12:00:00Z");
  const post = (server: Awaited<ReturnType<typeof app>>, url: string, auth: string | null, payload: unknown) =>
    server.inject({
      method: "POST",
      url,
      headers: { "content-type": "application/json", origin: ORIGIN, ...(auth ? { authorization: auth } : {}) },
      payload: JSON.stringify(payload),
    });

  it("issues a 90-day grant, keeps the token on the server and shows only its expiry", async () => {
    const { agents, calls } = fakeAgents(ACTIVE);
    const grants = memoryGrants();
    const { dashboard, forgotten } = forgetfulDashboard();
    const server = await app({ agents, grants, dashboard, now: () => NOW });
    const auth = `Bearer ${await token()}`;

    const prepared = await post(server, "/api/agent/grant/prepare", auth, {});
    expect(forgotten).toEqual([]);
    expect(prepared.statusCode).toBe(200);
    expect(prepared.body).not.toContain("ngt_");
    const body = calls.grantBodies[0];
    expect(body).toMatchObject({ type: "grant_issue", agent_id: "agent_1", expires_at: "2027-02-08T12:00:00.000Z" });
    expect(body?.credential).toMatch(/^[0-9a-f]{64}$/);

    const submitted = await post(server, "/api/agent/grant/submit", auth, { correlationId: "grant_1", signedData: { standard: "nep413" } });
    expect(submitted.json()).toEqual({ status: "success", expiresAt: "2027-02-08T12:00:00.000Z" });
    expect(calls.submittedTypes).toEqual(["grant_issue"]);
    expect(grants.get("did:privy:alice")?.token).toMatch(/^ngt_/);
    expect(forgotten).toEqual(["did:privy:alice"]);

    const read = await server.inject({ method: "GET", url: "/api/agent", headers: { origin: ORIGIN, authorization: auth } });
    expect(read.json()).toEqual({ ...ACTIVE, grant: { expiresAt: "2027-02-08T12:00:00.000Z" } });
    expect(read.body).not.toContain("ngt_");
  });

  it("refuses a grant without sign-in, without an agent, with a body, or sent by another user", async () => {
    const { agents, calls } = fakeAgents(ACTIVE);
    const grants = memoryGrants();
    const server = await app({ agents, grants });
    const alice = `Bearer ${await token()}`;
    const mallory = `Bearer ${await token({ sub: "did:privy:mallory" })}`;
    expect((await post(server, "/api/agent/grant/prepare", null, {})).statusCode).toBe(401);
    expect((await post(server, "/api/agent/grant/prepare", alice, { agentId: "agent_2" })).statusCode).toBe(400);
    expect((await post(server, "/api/agent/grant/prepare", alice, {})).statusCode).toBe(200);
    const stolen = await post(server, "/api/agent/grant/submit", mallory, { correlationId: "grant_1", signedData: {} });
    expect(stolen.statusCode).toBe(404);
    expect(calls.submitted).toEqual([]);
    expect(grants.records.size).toBe(0);

    const none = await app({ agents: fakeAgents().agents, grants });
    expect((await post(none, "/api/agent/grant/prepare", alice, {})).statusCode).toBe(409);
  });

  it("does not show a grant that has less than a day left, or that belongs to an older agent", async () => {
    const grants = memoryGrants();
    const server = await app({ agents: fakeAgents(ACTIVE).agents, grants, now: () => NOW });
    const auth = `Bearer ${await token()}`;
    const read = () => server.inject({ method: "GET", url: "/api/agent", headers: { origin: ORIGIN, authorization: auth } });
    await grants.put("did:privy:alice", { agentId: "agent_1", token: "ngt_x", expiresAt: "2026-11-11T06:00:00.000Z" });
    expect((await read()).json()).toMatchObject({ grant: null });
    await grants.put("did:privy:alice", { agentId: "agent_0", token: "ngt_x", expiresAt: "2027-02-08T12:00:00.000Z" });
    expect((await read()).json()).toMatchObject({ grant: null });
  });

  it("lasts 7, 30 or 90 days as the user picks, and nothing else", async () => {
    const { agents, calls } = fakeAgents(ACTIVE);
    const server = await app({ agents, now: () => NOW });
    const auth = `Bearer ${await token()}`;
    expect((await post(server, "/api/agent/grant/prepare", auth, { days: 7 })).json()).toMatchObject({ expiresAt: "2026-11-17T12:00:00.000Z" });
    expect(calls.grantBodies[0]?.expires_at).toBe("2026-11-17T12:00:00.000Z");
    for (const body of [{ days: 10 }, { days: 365 }, { days: "7" }]) expect((await post(server, "/api/agent/grant/prepare", auth, body)).statusCode).toBe(400);
  });

  it("closes earlier grants only after the new one is live, and only for their own user", async () => {
    const { agents, calls } = fakeAgents(ACTIVE, null, 2);
    const server = await app({ agents, now: () => NOW });
    const alice = `Bearer ${await token()}`;
    const mallory = `Bearer ${await token({ sub: "did:privy:mallory" })}`;
    const prepared = await post(server, "/api/agent/grant/prepare", alice, {});
    expect(prepared.json().revokes.map((r: { correlationId: string }) => r.correlationId)).toEqual(["revoke_1", "revoke_2"]);

    const revoke = (auth: string, id = "revoke_1") => post(server, "/api/agent/grant/revoke/submit", auth, { correlationId: id, signedData: { standard: "nep413" } });
    expect((await revoke(alice)).statusCode).toBe(404);
    await post(server, "/api/agent/grant/submit", alice, { correlationId: "grant_1", signedData: { standard: "nep413" } });
    expect((await revoke(mallory)).statusCode).toBe(404);
    expect((await revoke(alice)).json()).toEqual({ status: "success" });
    expect((await revoke(alice)).statusCode).toBe(404);
    expect(calls.submittedTypes).toEqual(["grant_issue", "grant_revoke"]);
  });

  it("stops at the per-user daily cap of grant documents", async () => {
    const { agents, calls } = fakeAgents(ACTIVE);
    const server = await app({ agents });
    const auth = `Bearer ${await token()}`;
    for (let i = 0; i < 5; i++) expect((await post(server, "/api/agent/grant/prepare", auth, {})).statusCode).toBe(200);
    expect((await post(server, "/api/agent/grant/prepare", auth, {})).statusCode).toBe(429);
    expect(calls.grantBodies).toHaveLength(5);
  });
});

describe("/api/agent/policy", () => {
  const ACTIVE: AgentLookup = { status: "active", agentId: "agent_1", agentAccount: "cd".repeat(32), ownerAccount: OWNER.accountId };
  const post = (server: Awaited<ReturnType<typeof app>>, url: string, auth: string | null, payload: unknown) =>
    server.inject({
      method: "POST",
      url,
      headers: { "content-type": "application/json", origin: ORIGIN, ...(auth ? { authorization: auth } : {}) },
      payload: JSON.stringify(payload),
    });

  it("prepares the change for the session's own agent and owner, and lets only that user submit it", async () => {
    const { agents, calls } = fakeAgents(ACTIVE);
    const { dashboard, forgotten } = forgetfulDashboard();
    const server = await app({ agents, dashboard });
    const alice = `Bearer ${await token()}`;
    const mallory = `Bearer ${await token({ sub: "did:privy:mallory" })}`;
    const prepared = await post(server, "/api/agent/policy/prepare", alice, { maxDeviationBps: 100 });
    expect(prepared.statusCode).toBe(200);
    expect(prepared.json()).toMatchObject({ status: "pending_signature", correlationId: "policy_1" });
    expect(calls.policies).toEqual([["agent_1", OWNER.accountId, 100]]);

    expect((await post(server, "/api/agent/policy/submit", mallory, { correlationId: "policy_1", signedData: {} })).statusCode).toBe(404);
    expect(calls.submitted).toEqual([]);
    const submitted = await post(server, "/api/agent/policy/submit", alice, { correlationId: "policy_1", signedData: { standard: "nep413" } });
    expect(submitted.json()).toEqual({ status: "success" });
    expect(calls.submittedTypes).toEqual(["policy_update"]);
    expect(forgotten).toEqual(["did:privy:alice"]);
  });

  it("accepts only 1%, 2% or 3%, and no other field", async () => {
    const { agents, calls } = fakeAgents(ACTIVE);
    const server = await app({ agents });
    const auth = `Bearer ${await token()}`;
    expect((await post(server, "/api/agent/policy/prepare", null, { maxDeviationBps: 100 })).statusCode).toBe(401);
    for (const body of [{}, { maxDeviationBps: 50 }, { maxDeviationBps: 500 }, { maxDeviationBps: "100" }, { maxDeviationBps: 100, destinations: { mode: "any" } }]) {
      expect((await post(server, "/api/agent/policy/prepare", auth, body)).statusCode).toBe(400);
    }
    expect(calls.policies).toEqual([]);
  });

  it("refuses without an agent, tells when the next change opens, and stops at the daily cap", async () => {
    const auth = `Bearer ${await token()}`;
    expect((await post(await app({ agents: fakeAgents().agents }), "/api/agent/policy/prepare", auth, { maxDeviationBps: 200 })).statusCode).toBe(409);
    const waiting = await post(await app({ agents: fakeAgents(ACTIVE, "2026-11-11T20:00:00.000Z").agents }), "/api/agent/policy/prepare", auth, { maxDeviationBps: 200 });
    expect(waiting.statusCode).toBe(409);
    expect(waiting.json()).toEqual({ error: "cooldown", availableAt: "2026-11-11T20:00:00.000Z" });

    const server = await app({ agents: fakeAgents(ACTIVE).agents });
    for (let i = 0; i < LIMITS.policyChangesPerUserPerDay; i++) expect((await post(server, "/api/agent/policy/prepare", auth, { maxDeviationBps: 200 })).statusCode).toBe(200);
    expect((await post(server, "/api/agent/policy/prepare", auth, { maxDeviationBps: 200 })).statusCode).toBe(429);
  });

  it("does not count a try that prepared nothing against the daily cap", async () => {
    const auth = `Bearer ${await token()}`;
    const waiting = await app({ agents: fakeAgents(ACTIVE, "2026-11-11T20:00:00.000Z").agents });
    for (let i = 0; i <= LIMITS.policyChangesPerUserPerDay; i++) expect((await post(waiting, "/api/agent/policy/prepare", auth, { maxDeviationBps: 200 })).statusCode).toBe(409);

    const failing = fakeAgents(ACTIVE).agents;
    failing.preparePolicy = () => Promise.reject(new AgentsUnavailableError("agents_unavailable"));
    failing.prepareRevokes = () => Promise.reject(new AgentsUnavailableError("agents_unavailable"));
    const down = await app({ agents: failing });
    for (let i = 0; i <= LIMITS.policyChangesPerUserPerDay; i++) expect((await post(down, "/api/agent/policy/prepare", auth, { maxDeviationBps: 200 })).statusCode).toBe(502);
    for (let i = 0; i <= LIMITS.grantsPerUserPerDay; i++) expect((await post(down, "/api/agent/grant/prepare", auth, {})).statusCode).toBe(502);
  });
});

describe("bearerToken", () => {
  it("accepts only a full Bearer header with a JWT shape", () => {
    expect(bearerToken("Bearer a.b.c")).toBe("a.b.c");
    expect(bearerToken("bearer a.b.c")).toBeNull();
    expect(bearerToken("Bearer a.b.c\nX: y")).toBeNull();
    expect(bearerToken("Bearer a.b")).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
  });
});
