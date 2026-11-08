import { readFileSync } from "node:fs";
import { exportSPKI, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { ScriptedBrain } from "../brains/scripted.js";
import { demoPolicy, demoPortfolio } from "../core/demo.js";
import type { PricedToken } from "../core/portfolio.js";
import type { Brain } from "../core/types.js";
import { buildApp, type AppDeps } from "./app.js";
import { bearerToken, privyVerifier, type TokenVerifier } from "./auth.js";
import { DailyQuota } from "./quota.js";

// Real tokens and prices copied from GET /v1/tokens.
const { tokens } = JSON.parse(readFileSync(new URL("../core/fixtures/priced-tokens.json", import.meta.url), "utf8")) as {
  tokens: PricedToken[];
};
const APP_ID = "test-app";
const ORIGIN = "https://hellointi.xyz";

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

async function app(overrides: Partial<AppDeps> = {}) {
  return buildApp({
    verify,
    brain: reportOnly(),
    tokens: () => Promise.resolve(tokens),
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
    expect(Object.keys(res.json()).sort()).toEqual(["events", "report", "responseIds", "simulated", "stopReason"]);
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

  it("limits requests per IP per minute", async () => {
    const server = await app();
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) codes.push((await chat(server, null, { message: "hi" })).statusCode);
    expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
    expect(codes[10]).toBe(429);
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

describe("bearerToken", () => {
  it("accepts only a full Bearer header with a JWT shape", () => {
    expect(bearerToken("Bearer a.b.c")).toBe("a.b.c");
    expect(bearerToken("bearer a.b.c")).toBeNull();
    expect(bearerToken("Bearer a.b.c\nX: y")).toBeNull();
    expect(bearerToken("Bearer a.b")).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
  });
});
