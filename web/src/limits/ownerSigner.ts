import { Signer } from "near-api-js";
import type { DelegateAction, PublicKey, SignedMessage, Transaction } from "near-api-js";
import type { LimitsConfig } from "./config";
import { describeOwnerDelegate, describeOwnerMessage, describeOwnerTransaction, RefusedSigningError, type OwnerTransaction } from "./ownerActions";

/** What near-api-js passes to sign a NEP-413 message. */
interface MessagePayload {
  message: string;
  recipient: string;
  nonce: Uint8Array;
  callbackUrl?: string;
}

/** Shows the user what a transaction does and resolves true only if they confirm it. */
export type ConfirmSigning = (lines: string[]) => Promise<boolean>;

export class SigningCancelledError extends Error {}

/**
 * Wraps the user's full-access signer: a transaction is signed only if every action is one
 * Inti uses (see ownerActions) and the user confirms the plain-language description first.
 * It also refuses to sign until the account has a second factor (passkey or authenticator app). The only delegate action it signs is
 * the one that creates the user's own agent, and the only messages are a grant for that agent and
 * a change of its price protection.
 */
export class OwnerSigner extends Signer {
  /** What the user approved in one confirmation, one entry per transaction, in signing order. */
  private approved: string[][] = [];
  /** Messages the user approved in one confirmation, in signing order. */
  private approvedMessages: { message: string; recipient: string; nonce: Uint8Array }[] = [];

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

  /**
   * Shows every transaction of one user action in a single confirmation. Each one is then signed
   * without asking again only if it reads exactly as approved, in the same order.
   */
  async approveAll(transactions: readonly OwnerTransaction[]): Promise<void> {
    const each = transactions.map((t) => describeOwnerTransaction(t, this.config));
    if (!this.hasPasskey()) throw new RefusedSigningError("Inti refused to sign: protect your account with a passkey or an authenticator app first.");
    this.approved = [];
    if (!(await this.confirm(each.flat()))) throw new SigningCancelledError("You cancelled the signature. Nothing was sent.");
    this.approved = each;
  }

  override async signTransaction(transaction: Transaction) {
    const lines = describeOwnerTransaction(transaction, this.config);
    if (!this.hasPasskey()) throw new RefusedSigningError("Inti refused to sign: protect your account with a passkey or an authenticator app first.");
    const next = this.approved.shift();
    const preApproved = next !== undefined && next.length === lines.length && next.every((line, i) => line === lines[i]);
    if (!preApproved) {
      this.approved = [];
      if (!(await this.confirm(lines))) throw new SigningCancelledError("You cancelled the signature. Nothing was sent.");
    }
    return this.inner.signTransaction(transaction);
  }

  /**
   * The only messages it signs are a grant for the user's own agent and a change of its price
   * protection, after the user confirms them.
   */
  override async signNep413Message(accountId: string, params: MessagePayload): Promise<SignedMessage> {
    if (params.callbackUrl !== undefined) throw new RefusedSigningError("Inti refused to sign: a signed message never redirects anywhere.");
    const publicKey = (await this.inner.getPublicKey()).toString();
    const lines = describeOwnerMessage(params, accountId, publicKey, this.config, Date.now());
    if (!this.hasPasskey()) throw new RefusedSigningError("Inti refused to sign: protect your account with a passkey or an authenticator app first.");
    // Signed without asking again only if it is the next message the user already approved, unchanged.
    const next = this.approvedMessages.shift();
    const sameNonce = next !== undefined && next.nonce.length === params.nonce.length && next.nonce.every((b, i) => b === params.nonce[i]);
    if (next === undefined || next.message !== params.message || next.recipient !== params.recipient || !sameNonce) {
      this.approvedMessages = [];
      if (!(await this.confirm(lines))) throw new SigningCancelledError("You cancelled the signature. Nothing was sent.");
    }
    return this.inner.signNep413Message(accountId, params);
  }

  /**
   * Shows every message of one user action in a single confirmation (a new grant and the closing
   * of earlier ones). Each one is then signed without asking again, in the same order.
   */
  async approveMessages(accountId: string, messages: readonly { message: string; recipient: string; nonce: Uint8Array }[]): Promise<void> {
    const publicKey = (await this.inner.getPublicKey()).toString();
    const lines = messages.flatMap((m) => describeOwnerMessage(m, accountId, publicKey, this.config, Date.now()));
    if (!this.hasPasskey()) throw new RefusedSigningError("Inti refused to sign: protect your account with a passkey or an authenticator app first.");
    this.approvedMessages = [];
    if (!(await this.confirm(lines))) throw new SigningCancelledError("You cancelled the signature. Nothing was sent.");
    this.approvedMessages = messages.map((m) => ({ message: m.message, recipient: m.recipient, nonce: Uint8Array.from(m.nonce) }));
  }

  override async signDelegateAction(delegateAction: DelegateAction) {
    const lines = describeOwnerDelegate(delegateAction, this.config);
    if (!this.hasPasskey()) throw new RefusedSigningError("Inti refused to sign: protect your account with a passkey or an authenticator app first.");
    if (!(await this.confirm(lines))) throw new SigningCancelledError("You cancelled the signature. Nothing was sent.");
    return this.inner.signDelegateAction(delegateAction);
  }
}
