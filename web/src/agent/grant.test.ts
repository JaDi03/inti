import { KeyPair, type Signer } from "near-api-js";
import { afterEach, describe, expect, it, vi } from "vitest";

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

/** A signer that records what it was asked to sign. */
function signer() {
  const asked: { accountId: string; nonce: Uint8Array; recipient: string }[] = [];
  const s = {
    signNep413Message: (accountId: string, params: { nonce: Uint8Array; recipient: string }) => {
      asked.push({ accountId, nonce: params.nonce, recipient: params.recipient });
      return Promise.resolve({ accountId, publicKey: key.getPublicKey(), signature: new Uint8Array(64).fill(1) });
    },
  } as unknown as Signer;
  return { s, asked };
}

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

  it("signs nothing when the server sends something that is not a NEP-413 grant", async () => {
    for (const intent of [{ ...INTENT, standard: "nep366" }, { ...INTENT, payload: { ...INTENT.payload, nonce: btoa("short") } }, { standard: "nep413" }]) {
      server({ status: "pending_signature", correlationId: "intent_1", intent });
      const { s, asked } = signer();
      await expect(issueGrant({ accessToken: "t", accountId: "ab".repeat(32), signer: s })).rejects.toThrow(GrantError);
      expect(asked).toHaveLength(0);
    }
  });
});
