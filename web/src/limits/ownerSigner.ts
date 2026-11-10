import { Signer } from "near-api-js";
import type { DelegateAction, PublicKey, SignedMessage, Transaction } from "near-api-js";
import type { LimitsConfig } from "./config";
import { describeOwnerDelegate, describeOwnerTransaction, RefusedSigningError } from "./ownerActions";

/** Shows the user what a transaction does and resolves true only if they confirm it. */
export type ConfirmSigning = (lines: string[]) => Promise<boolean>;

export class SigningCancelledError extends Error {}

/**
 * Wraps the user's full-access signer: a transaction is signed only if every action is one
 * Inti uses (see ownerActions) and the user confirms the plain-language description first.
 * It also refuses to sign until the account has a passkey. The only delegate action it signs is
 * the one that creates the user's own agent. Messages are never signed through it.
 */
export class OwnerSigner extends Signer {
  constructor(
    private readonly inner: Signer,
    private readonly config: LimitsConfig,
    private readonly confirm: ConfirmSigning,
    private readonly hasPasskey: () => boolean,
  ) {
    super();
  }

  getPublicKey(): Promise<PublicKey> {
    return this.inner.getPublicKey();
  }

  protected signBytes(): Promise<Uint8Array> {
    return Promise.reject(new RefusedSigningError("Inti refused to sign: raw bytes are never signed with your account key."));
  }

  override async signTransaction(transaction: Transaction) {
    const lines = describeOwnerTransaction(transaction, this.config);
    if (!this.hasPasskey()) throw new RefusedSigningError("Inti refused to sign: add a passkey to your account first.");
    if (!(await this.confirm(lines))) throw new SigningCancelledError("You cancelled the signature. Nothing was sent.");
    return this.inner.signTransaction(transaction);
  }

  override signNep413Message(): Promise<SignedMessage> {
    return Promise.reject(new RefusedSigningError("Inti refused to sign: messages are never signed with your account key."));
  }

  override async signDelegateAction(delegateAction: DelegateAction) {
    const lines = describeOwnerDelegate(delegateAction, this.config);
    if (!this.hasPasskey()) throw new RefusedSigningError("Inti refused to sign: add a passkey to your account first.");
    if (!(await this.confirm(lines))) throw new SigningCancelledError("You cancelled the signature. Nothing was sent.");
    return this.inner.signDelegateAction(delegateAction);
  }
}
