import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { KeyType, PublicKey, Signer } from "near-api-js";

/** Signs a 0x-prefixed 32-byte hash with the user's Privy NEAR wallet (Privy `signRawHash`). */
export type SignRawHash = (input: {
  address: string;
  chainType: "near";
  hash: `0x${string}`;
}) => Promise<{ signature: `0x${string}` }>;

/**
 * near-api-js Signer backed by a Privy embedded NEAR wallet, following the
 * Privy guide in the NEAR docs (docs.near.org/web3-apps/tutorials/privy).
 * near-api-js serializes and SHA-256 hashes NEP-413 messages and NEP-366
 * delegate actions itself and passes the 32-byte hash to signBytes, which is
 * exactly what Privy's raw hash signing signs with the ed25519 key.
 */
export class PrivyNearSigner extends Signer {
  constructor(
    /** Implicit account id: the 64-hex ed25519 public key. */
    readonly accountId: string,
    private readonly signRawHash: SignRawHash,
  ) {
    super();
    if (!/^[0-9a-f]{64}$/.test(accountId)) throw new Error("expected a 64-hex implicit NEAR account");
  }

  getPublicKey(): Promise<PublicKey> {
    return Promise.resolve(new PublicKey({ keyType: KeyType.ED25519, data: hexToBytes(this.accountId) }));
  }

  protected async signBytes(bytes: Uint8Array): Promise<Uint8Array> {
    const { signature } = await this.signRawHash({
      address: this.accountId,
      chainType: "near",
      hash: `0x${bytesToHex(bytes)}`,
    });
    return hexToBytes(signature.startsWith("0x") ? signature.slice(2) : signature);
  }
}
