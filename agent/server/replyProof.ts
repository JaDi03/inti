import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { NEAR_AI_BASE_URL } from "../brains/nearai.js";

/**
 * Checks that each model call behind one chat reply was signed, inside the TEE, by the key the
 * hardware check found in the model's attested chip (docs.near.ai/cloud/verification: response
 * signatures). The signed text must name the model and the SHA-256 of the exact request and
 * response bytes Inti kept. Every machine serving the model shares that key, so this proves a
 * verified machine of this model signed the reply, not which one.
 */

/** One model call: its response id and the hashes of the bytes sent and received. */
export interface SignedCall {
  responseId: string;
  requestHash: string;
  responseHash: string;
}

export type CallFailure = "unavailable" | "not_model" | "other_bytes" | "other_signer" | "not_attested";

export interface ReplyProof {
  ok: boolean;
  calls: { responseId: string; ok: boolean; failure: CallFailure | null }[];
  /** The key the hardware check found in the chip, or null when that check did not pass. */
  attestedKey: string | null;
  checkedAt: string;
}

export interface ProofDeps {
  fetch: typeof fetch;
  apiKey: string;
  /** The signing key of the last hardware check that passed, or null. */
  attestedKey: () => Promise<string | null>;
  wait: (ms: number) => Promise<void>;
  now: () => number;
}

const signatureSchema = z.object({
  text: z.string().max(1024),
  signature: z.string().regex(/^(0x)?[0-9a-fA-F]{130}$/),
  signing_address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  signing_algo: z.literal("ecdsa"),
  signature_kind: z.string(),
});

/** NEAR AI may need a moment before a reply's signature is ready (docs: a 404 can be retried briefly). */
const SIGNATURE_TRIES = 4;
const RETRY_MS = 1500;
const REQUEST_TIMEOUT_MS = 15_000;

/** The Ethereum address that signed `text` as an EIP-191 personal message. */
export function recoverSigner(text: string, signatureHex: string): string {
  const message = new TextEncoder().encode(text);
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${message.length}`);
  const digest = keccak_256(new Uint8Array([...prefix, ...message]));
  const bytes = Uint8Array.from(Buffer.from(signatureHex.replace(/^0x/, ""), "hex"));
  const v = bytes[64] ?? 0;
  const recovery = v >= 27 ? v - 27 : v;
  const key = secp256k1.Signature.fromBytes(new Uint8Array([recovery, ...bytes.subarray(0, 64)]), "recovered").recoverPublicKey(digest);
  return "0x" + Buffer.from(keccak_256(key.toBytes(false).subarray(1)).subarray(12)).toString("hex");
}

async function fetchSignature(model: string, responseId: string, deps: ProofDeps): Promise<z.infer<typeof signatureSchema> | null> {
  for (let i = 0; i < SIGNATURE_TRIES; i++) {
    const url = new URL(`${NEAR_AI_BASE_URL}/signature/${encodeURIComponent(responseId)}`);
    url.searchParams.set("model", model);
    url.searchParams.set("signing_algo", "ecdsa");
    try {
      const res = await deps.fetch(url, { headers: { Authorization: `Bearer ${deps.apiKey}` }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      // A 2xx with error_code and message is "not available", not a signature (docs).
      const parsed = res.ok ? signatureSchema.safeParse(await res.json()) : null;
      if (parsed?.success) return parsed.data;
      if (res.status !== 404) return null;
    } catch {
      return null;
    }
    await deps.wait(RETRY_MS);
  }
  return null;
}

/** Checks every call of one reply. Any call that does not check out makes the reply unproven. */
export async function proveReply(model: string, calls: readonly SignedCall[], deps: ProofDeps): Promise<ReplyProof> {
  const attestedKey = (await deps.attestedKey())?.toLowerCase() ?? null;
  const results: ReplyProof["calls"] = [];
  for (const call of calls) {
    const failure = await checkCall(model, call, attestedKey, deps);
    results.push({ responseId: call.responseId, ok: failure === null, failure });
  }
  return { ok: results.length > 0 && results.every((r) => r.ok), calls: results, attestedKey, checkedAt: new Date(deps.now()).toISOString() };
}

async function checkCall(model: string, call: SignedCall, attestedKey: string | null, deps: ProofDeps): Promise<CallFailure | null> {
  const sig = await fetchSignature(model, call.responseId, deps);
  if (!sig) return "unavailable";
  // Only the model's own TEE signature ties the reply to the attested chip; a gateway signature does not.
  if (sig.signature_kind !== "provider_tee") return "not_model";
  if (sig.text !== `${model}:${call.requestHash}:${call.responseHash}`) return "other_bytes";
  let signer: string;
  try {
    signer = recoverSigner(sig.text, sig.signature);
  } catch {
    return "other_signer";
  }
  if (signer !== sig.signing_address.toLowerCase()) return "other_signer";
  if (attestedKey === null || signer !== attestedKey) return "not_attested";
  return null;
}

/**
 * The calls behind recent replies, each under a random id that only its user can read. In memory:
 * a restart forgets them, and the oldest are dropped first when full.
 */
export class ProofStore {
  private readonly entries = new Map<string, { userId: string; model: string; calls: SignedCall[]; proof: ReplyProof | null }>();

  constructor(private readonly max: number) {}

  remember(userId: string, model: string, calls: SignedCall[]): string {
    if (this.entries.size >= this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    const id = randomUUID();
    this.entries.set(id, { userId, model, calls, proof: null });
    return id;
  }

  /** The entry, only for the user it belongs to. */
  get(id: string, userId: string) {
    const entry = this.entries.get(id);
    return entry?.userId === userId ? entry : null;
  }
}
