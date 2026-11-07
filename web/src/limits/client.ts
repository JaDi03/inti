import { Account, JsonRpcProvider, PublicKey, actions } from "near-api-js";
import type { Signer } from "near-api-js";
import type { LimitsConfig } from "./config";

const TGAS = 10n ** 12n;
/** Storage staking rate: 1E19 yoctoNEAR per byte (docs.near.org/protocol/storage/storage-staking). */
const YOCTO_PER_BYTE = 10n ** 19n;
/** Code hash of an account with no contract. */
const NO_CODE = "11111111111111111111111111111111";
/** Room for contract state, token registration and gas on top of the code storage. */
const ACTIVATION_MARGIN = 10n ** 23n; // 0.1 NEAR

export interface SpendLimit {
  perOrder: bigint;
  perDay: bigint;
}

export type LimitsStatus =
  | { kind: "unfunded"; available: bigint }
  | { kind: "not-installed"; available: bigint }
  | {
      kind: "installed";
      available: bigint;
      intiConnected: boolean;
      agent: string;
      limit: SpendLimit | null;
      spentToday: bigint;
      /** Token balance the agent can be funded from. */
      spendable: bigint;
    };

export class LimitsClient {
  readonly provider: JsonRpcProvider;

  constructor(readonly config: LimitsConfig) {
    this.provider = new JsonRpcProvider({ url: config.rpcUrl });
  }

  /** NEAR locked while the Spending Limits code is on the account. */
  static storageCost(wasmBytes: number): bigint {
    return BigInt(wasmBytes) * YOCTO_PER_BYTE;
  }

  /** Available NEAR the account needs before activating with `fundAmount` of token. */
  static activationNeeds(wasmBytes: number, fundAmount: bigint): bigint {
    return LimitsClient.storageCost(wasmBytes) + ACTIVATION_MARGIN + fundAmount;
  }

  async loadWasm(): Promise<Uint8Array> {
    const res = await fetch(this.config.wasmUrl);
    if (!res.ok) throw new Error(`Could not load the Spending Limits code (${res.status}).`);
    return new Uint8Array(await res.arrayBuffer());
  }

  private async view<T>(contractId: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
    return (await this.provider.callFunction({ contractId, method, args })) as T;
  }

  async status(accountId: string): Promise<LimitsStatus> {
    let state;
    try {
      state = await new Account(accountId, this.provider).getState();
    } catch {
      return { kind: "unfunded", available: 0n };
    }
    const available = state.balance.available;
    if (state.codeHash === NO_CODE) return { kind: "not-installed", available };

    const token = this.config.token.id;
    const [onChainConfig, limit, spent, balance, intiConnected] = await Promise.all([
      this.view<{ agent: string }>(accountId, "get_config"),
      this.view<{ per_order: string; per_day: string } | null>(accountId, "get_limit", { token }),
      this.view<string>(accountId, "get_spent_today", { token }),
      this.view<string>(token, "ft_balance_of", { account_id: accountId }),
      this.hasIntiKey(accountId),
    ]);
    return {
      kind: "installed",
      available,
      intiConnected,
      agent: onChainConfig.agent,
      limit: limit ? { perOrder: BigInt(limit.per_order), perDay: BigInt(limit.per_day) } : null,
      spentToday: BigInt(spent),
      spendable: BigInt(balance),
    };
  }

  private async hasIntiKey(accountId: string): Promise<boolean> {
    try {
      await new Account(accountId, this.provider).getAccessKey(this.config.intiPublicKey);
      return true;
    } catch {
      return false;
    }
  }

  private account(accountId: string, signer: Signer): Account {
    return new Account(accountId, this.provider, signer);
  }

  private intiKeyAction(accountId: string) {
    return actions.addFunctionCallAccessKey(
      PublicKey.fromString(this.config.intiPublicKey),
      accountId,
      ["fund_agent"],
      this.config.intiKeyAllowanceYocto,
    );
  }

  /**
   * Activation, two transactions signed in sequence:
   * 1. on the user's account: install the code, init, set the limit, add Inti's key;
   * 2. on the token: register the user and wrap `fundAmount` NEAR so orders can be funded.
   * Returns the transaction hashes.
   */
  async activate(accountId: string, signer: Signer, wasm: Uint8Array, limit: SpendLimit, fundAmount: bigint): Promise<string[]> {
    const account = this.account(accountId, signer);
    const { token } = this.config;
    const install = await account.signAndSendTransaction({
      receiverId: accountId,
      actions: [
        actions.deployContract(wasm),
        actions.functionCall("new", { intents: this.config.intentsAccount, agent: this.config.agentAccount }, 30n * TGAS, 0n),
        actions.functionCall("set_limit", limitArgs(token.id, limit), 30n * TGAS, 1n),
        this.intiKeyAction(accountId),
      ],
    });
    const bounds = await this.view<{ min: string }>(token.id, "storage_balance_bounds");
    const funding = await account.signAndSendTransaction({
      receiverId: token.id,
      actions: [
        actions.functionCall("storage_deposit", { account_id: accountId, registration_only: true }, 10n * TGAS, BigInt(bounds.min)),
        actions.functionCall("near_deposit", {}, 10n * TGAS, fundAmount),
      ],
    });
    return [install.transaction.hash, funding.transaction.hash];
  }

  async setLimit(accountId: string, signer: Signer, limit: SpendLimit): Promise<string> {
    const res = await this.account(accountId, signer).signAndSendTransaction({
      receiverId: accountId,
      actions: [actions.functionCall("set_limit", limitArgs(this.config.token.id, limit), 30n * TGAS, 1n)],
    });
    return res.transaction.hash;
  }

  async disconnectInti(accountId: string, signer: Signer): Promise<string> {
    const res = await this.account(accountId, signer).signAndSendTransaction({
      receiverId: accountId,
      actions: [actions.deleteKey(PublicKey.fromString(this.config.intiPublicKey))],
    });
    return res.transaction.hash;
  }

  async reconnectInti(accountId: string, signer: Signer): Promise<string> {
    const res = await this.account(accountId, signer).signAndSendTransaction({
      receiverId: accountId,
      actions: [this.intiKeyAction(accountId)],
    });
    return res.transaction.hash;
  }
}

function limitArgs(token: string, limit: SpendLimit) {
  return { token, per_order: limit.perOrder.toString(), per_day: limit.perDay.toString() };
}
