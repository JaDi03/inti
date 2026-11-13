import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ProofStore, proveReply, recoverSigner, type ProofDeps, type SignedCall } from "./replyProof.js";

// One real reply of Inti's model, its exact bytes and NEAR AI's signature for it.
const fixture = JSON.parse(readFileSync(new URL("./fixtures/near-ai-signed-reply.json", import.meta.url), "utf8")) as {
  model: string;
  chatId: string;
  request: string;
  response: string;
  signature: { text: string; signature: string; signing_address: string; signing_algo: string; signature_kind: string };
};
const sha = (b64: string) => createHash("sha256").update(Buffer.from(b64, "base64")).digest("hex");
const CALL: SignedCall = { responseId: fixture.chatId, requestHash: sha(fixture.request), responseHash: sha(fixture.response) };
const KEY = fixture.signature.signing_address.toLowerCase();

/** NEAR AI answering with the recorded signature unless told otherwise. */
function world(opts: { signature?: Partial<typeof fixture.signature>; statuses?: number[]; attestedKey?: string | null } = {}) {
  const asked: string[] = [];
  const statuses = [...(opts.statuses ?? [])];
  const deps: ProofDeps = {
    fetch: ((input: URL | string, init?: RequestInit) => {
      asked.push(`${new URL(input.toString()).pathname} ${new Headers(init?.headers).get("authorization") ? "with key" : "no key"}`);
      const status = statuses.shift() ?? 200;
      return Promise.resolve(status === 200 ? Response.json({ ...fixture.signature, ...opts.signature }) : Response.json({ error: "not found" }, { status }));
    }) as typeof fetch,
    apiKey: "test-key",
    attestedKey: () => Promise.resolve(opts.attestedKey === undefined ? KEY : opts.attestedKey),
    wait: () => Promise.resolve(),
    now: () => Date.parse("2026-11-13T08:00:00Z"),
  };
  return { deps, asked };
}

describe("recoverSigner", () => {
  it("recovers the address that signed a real NEAR AI reply", () => {
    expect(recoverSigner(fixture.signature.text, fixture.signature.signature)).toBe(KEY);
    expect(recoverSigner(fixture.signature.text + " ", fixture.signature.signature)).not.toBe(KEY);
  });
});

describe("proveReply", () => {
  it("proves a real reply signed by the attested model key over the exact bytes Inti kept", async () => {
    const { deps, asked } = world();
    const proof = await proveReply(fixture.model, [CALL], deps);
    expect(proof).toEqual({ ok: true, calls: [{ responseId: fixture.chatId, ok: true, failure: null }], attestedKey: KEY, checkedAt: "2026-11-13T08:00:00.000Z" });
    expect(asked).toEqual([`/v1/signature/${fixture.chatId} with key`]);
  });

  it("waits briefly for a signature that is not ready, and says when there is none", async () => {
    expect((await proveReply(fixture.model, [CALL], world({ statuses: [404, 404] }).deps)).ok).toBe(true);
    expect((await proveReply(fixture.model, [CALL], world({ statuses: [404, 404, 404, 404] }).deps)).calls[0]?.failure).toBe("unavailable");
    expect((await proveReply(fixture.model, [CALL], world({ statuses: [500] }).deps)).calls[0]?.failure).toBe("unavailable");
  });

  it("refuses other bytes, a gateway signature, another signer, or a key the hardware check did not find", async () => {
    const failure = async (opts: Parameters<typeof world>[0], call: SignedCall = CALL) => (await proveReply(fixture.model, [call], world(opts).deps)).calls[0]?.failure;
    expect(await failure({}, { ...CALL, responseHash: "00".repeat(32) })).toBe("other_bytes");
    expect(await failure({ signature: { signature_kind: "gateway" } })).toBe("not_model");
    expect(await failure({ signature: { signing_address: "0x" + "11".repeat(20) } })).toBe("other_signer");
    expect(await failure({ attestedKey: null })).toBe("not_attested");
    expect(await failure({ attestedKey: "0x" + "22".repeat(20) })).toBe("not_attested");
  });

  it("proves a reply only when every call behind it checks out", async () => {
    const proof = await proveReply(fixture.model, [CALL, { ...CALL, requestHash: "00".repeat(32) }], world().deps);
    expect(proof.ok).toBe(false);
    expect(proof.calls.map((c) => c.ok)).toEqual([true, false]);
    expect((await proveReply(fixture.model, [], world().deps)).ok).toBe(false);
  });
});

describe("ProofStore", () => {
  it("gives a reply's calls only to its own user, and forgets the oldest when full", () => {
    const store = new ProofStore(2);
    const first = store.remember("did:privy:alice", fixture.model, [CALL]);
    expect(store.get(first, "did:privy:bob")).toBeNull();
    expect(store.get(first, "did:privy:alice")?.calls).toEqual([CALL]);
    store.remember("did:privy:alice", fixture.model, [CALL]);
    store.remember("did:privy:alice", fixture.model, [CALL]);
    expect(store.get(first, "did:privy:alice")).toBeNull();
  });
});
