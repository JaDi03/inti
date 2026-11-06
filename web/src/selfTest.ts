import { ed25519 } from "@noble/curves/ed25519.js";
import { hexToBytes } from "@noble/hashes/utils.js";
import { actions, buildDelegateAction } from "near-api-js";
import { PrivyNearSigner, type SignRawHash } from "./privySigner";

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * Off-chain checks of the two signatures the Agent API asks a NEAR owner for.
 * Nothing is sent to any chain or API: each signature is verified locally
 * against the implicit account's public key and the exact hash that was signed.
 */
export async function runSelfTest(accountId: string, signRawHash: SignRawHash): Promise<CheckResult[]> {
  const publicKey = hexToBytes(accountId);

  // Record the hash near-api-js hands to the signer, so the check uses it as-is.
  const signedHashes: Uint8Array[] = [];
  const recording: SignRawHash = (input) => {
    signedHashes.push(hexToBytes(input.hash.slice(2)));
    return signRawHash(input);
  };
  const signer = new PrivyNearSigner(accountId, recording);
  const results: CheckResult[] = [];

  try {
    const nonce = crypto.getRandomValues(new Uint8Array(32));
    const signed = await signer.signNep413Message(accountId, {
      message: "Inti login test: this signature moves no funds.",
      recipient: "inti.test",
      nonce,
    });
    const hash = signedHashes.at(-1);
    const ok = hash !== undefined && hash.length === 32 && ed25519.verify(signed.signature, hash, publicKey);
    results.push({ name: "NEP-413 signed message", ok, detail: ok ? "signature valid for this account key" : "signature does not verify" });
  } catch (error) {
    results.push({ name: "NEP-413 signed message", ok: false, detail: error instanceof Error ? error.message : "failed" });
  }

  try {
    const delegateAction = buildDelegateAction({
      actions: [actions.transfer(1n)],
      maxBlockHeight: 1n,
      nonce: 1n,
      publicKey: await signer.getPublicKey(),
      receiverId: accountId,
      senderId: accountId,
    });
    const { delegateHash, signedDelegate } = await signer.signDelegateAction(delegateAction);
    const ok = ed25519.verify(signedDelegate.signature.data, delegateHash, publicKey);
    results.push({ name: "NEP-366 delegate action", ok, detail: ok ? "signature valid (test action, never submitted)" : "signature does not verify" });
  } catch (error) {
    results.push({ name: "NEP-366 delegate action", ok: false, detail: error instanceof Error ? error.message : "failed" });
  }

  return results;
}
