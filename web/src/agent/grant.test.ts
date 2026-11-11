import { KeyPair } from "near-api-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OwnerSigner } from "../limits/ownerSigner";

// The module reads the API URL when it loads, so the setting goes in first.
vi.stubEnv("INTI_API_URL", "http://inti.test");
const { GrantError, issueGrant } = await import("./grant");

const key = KeyPair.fromRandom("ed25519");
const NONCE = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const INTENT = { standard: "nep413", payload: { message: '{"domain":"near-intents-agent-api.agent-grant.v6"}', recipient: "api.demo.agentsonintents.com", nonce: NONCE } };

/** Inti's server, answering the two grant routes and recording what the web sent. */
function server(prepared: unknown) {
  const sent: { url: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: URL, init: RequestInit) => {
      const body = init.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
      sent.push({ url: url.pathname, body });
      const answer = url.pathname.endsWith("/prepare") ? prepared : { status: "success", expiresAt: "2027-02-08T12:00:00.000Z" };
      return Promise.resolve(new Response(JSON.stringify(answer), { status: 200 }));
    }),
  );
  return sent;
}

/** A signer that records what it was asked to approve and to sign. */
function signer() {
  const asked: { accountId: string; nonce: Uint8Array; recipient: string; message: string }[] = [];
  const approved: string[][] = [];
  const s = {
    approveMessages: (_accountId: string, messages: { message: string }[]) => {
      approved.push(messages.map((m) => m.message));
      return Promise.resolve();
    },
    signNep413Message: (accountId: string, params: { nonce: Uint8Array; recipient: string; message: string }) => {
      asked.push({ accountId, nonce: params.nonce, recipient: params.recipient, message: params.message });
      return Promise.resolve({ accountId, publicKey: key.getPublicKey(), signature: new Uint8Array(64).fill(1) });
    },
  } as unknown as OwnerSigner;
  return { s, asked, approved };
}

const REVOKE = { standard: "nep413", payload: { message: '{"action":"revoke_grant"}', recipient: "api.demo.agentsonintents.com", nonce: NONCE } };

afterEach(() => vi.unstubAllGlobals());

describe("issueGrant", () => {
  it("signs the grant with the decoded nonce and sends back the intent, the key and the signature", async () => {
    const sent = server({ status: "pending_signature", correlationId: "intent_1", intent: INTENT, preview: { summary: "s" }, expiresAt: "x" });
    const { s, asked } = signer();
    expect(await issueGrant({ accessToken: "t", accountId: "ab".repeat(32), signer: s })).toBe("2027-02-08T12:00:00.000Z");
    expect(asked[0]?.nonce).toEqual(new Uint8Array(32).fill(7));
    expect(sent[1]).toEqual({
      url: "/api/agent/grant/submit",
      body: { correlationId: "intent_1", signedData: { ...INTENT, public_key: key.getPublicKey().toString(), signature: btoa(String.fromCharCode(...new Uint8Array(64).fill(1))) } },
    });
  });

  it("asks once for the new grant and the closing of earlier ones, and closes them only after the new one is live", async () => {
    const sent = server({ status: "pending_signature", correlationId: "intent_1", intent: INTENT, expiresAt: "x", revokes: [{ correlationId: "intent_2", intent: REVOKE }] });
    const { s, asked, approved } = signer();
    await issueGrant({ accessToken: "t", accountId: "ab".repeat(32), signer: s, days: 7 });
    expect(sent[0]).toEqual({ url: "/api/agent/grant/prepare", body: { days: 7 } });
    expect(approved).toEqual([[INTENT.payload.message, REVOKE.payload.message]]);
    expect(asked.map((a) => a.message)).toEqual([INTENT.payload.message, REVOKE.payload.message]);
    expect(sent.map((s) => s.url)).toEqual(["/api/agent/grant/prepare", "/api/agent/grant/submit", "/api/agent/grant/revoke/submit"]);
  });

  it("closes nothing when the new grant does not go live", async () => {
    const sent: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: URL) => {
        sent.push(url.pathname);
        const answer = url.pathname.endsWith("/prepare")
          ? { status: "pending_signature", correlationId: "intent_1", intent: INTENT, revokes: [{ correlationId: "intent_2", intent: REVOKE }] }
          : { status: "failed" };
        return Promise.resolve(new Response(JSON.stringify(answer), { status: 200 }));
      }),
    );
    const { s, asked } = signer();
    await expect(issueGrant({ accessToken: "t", accountId: "ab".repeat(32), signer: s })).rejects.toThrow(GrantError);
    expect(asked).toHaveLength(1);
    expect(sent).toEqual(["/api/agent/grant/prepare", "/api/agent/grant/submit"]);
  });

  it("signs nothing when the server sends something that is not a NEP-413 grant", async () => {
    for (const intent of [{ ...INTENT, standard: "nep366" }, { ...INTENT, payload: { ...INTENT.payload, nonce: btoa("short") } }, { standard: "nep413" }]) {
      server({ status: "pending_signature", correlationId: "intent_1", intent });
      const { s, asked } = signer();
      await expect(issueGrant({ accessToken: "t", accountId: "ab".repeat(32), signer: s })).rejects.toThrow(GrantError);
      expect(asked).toHaveLength(0);
    }
  });
});
