import { Account, JsonRpcProvider, PublicKey, actions } from "near-api-js";
import type { Signer } from "near-api-js";
import { ASSET_KEYS, type AssetKey } from "../../../agent/policy/assets";
import type { LimitsConfig } from "./config";
import { assetContract, EMPTY_CONTRACT, wasmSha256, type OwnerTransaction } from "./ownerActions";

const TGAS = 10n ** 12n;
/** Storage staking rate: 1E19 yoctoNEAR per byte (docs.near.org/protocol/storage/storage-staking). */
const YOCTO_PER_BYTE = 10n ** 19n;
/** Code hash of an account with no contract. */
const NO_CODE = "11111111111111111111111111111111";
/** Room for contract state, token registration and gas on top of the code storage. */
const ACTIVATION_MARGIN = 10n ** 23n; // 0.1 NEAR
/** Room for creating the user's agent; the Agent API asks about 0.0145 NEAR to store its rules. */
export const AGENT_CREATION_RESERVE = 2n * 10n ** 22n; // 0.02 NEAR

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

  /**
   * Available NEAR the account needs before activating with `fundAmount` of token, plus the cost
   * of creating the agent while the user has none yet.
   */
  static activationNeeds(wasmBytes: number, fundAmount: bigint, createsAgent = false): bigint {
    return LimitsClient.storageCost(wasmBytes) + ACTIVATION_MARGIN + fundAmount + (createsAgent ? AGENT_CREATION_RESERVE : 0n);
  }

  async loadWasm(): Promise<Uint8Array> {
    const res = await fetch(this.config.wasmUrl);
    if (!res.ok) throw new Error(`Could not load the Spending Limits code (${res.status}).`);
    const wasm = new Uint8Array(await res.arrayBuffer());
    if (wasmSha256(wasm) !== this.config.wasmSha256) throw new Error("The Spending Limits code does not match the expected build, so it will not be installed.");
    return wasm;
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
      this.view<string>(accountId, "get_spent_last_24h", { token }),
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

  /** For each asset the agent may buy: whether the user's wallet can receive it, and how much it holds. */
  async assets(accountId: string): Promise<{ key: AssetKey; enabled: boolean; balance: bigint }[]> {
    return Promise.all(
      ASSET_KEYS.map(async (key) => {
        const contract = assetContract(key);
        const [registration, balance] = await Promise.all([
          this.view<unknown>(contract, "storage_balance_of", { account_id: accountId }),
          this.view<string | null>(contract, "ft_balance_of", { account_id: accountId }),
        ]);
        return { key, enabled: registration != null, balance: BigInt(balance ?? "0") };
      }),
    );
  }

  /** Registers the user's account with an asset's token, for its own one-time fee, so purchases can reach the wallet. */
  async enableAsset(accountId: string, signer: Signer, key: AssetKey): Promise<string> {
    const contract = assetContract(key);
    const bounds = await this.view<{ min: string }>(contract, "storage_balance_bounds");
    const sent = await this.account(accountId, signer).signAndSendTransaction({
      receiverId: contract,
      actions: [actions.functionCall("storage_deposit", { account_id: accountId, registration_only: true }, 10n * TGAS, BigInt(bounds.min))],
    });
    return sent.transaction.hash;
  }

  /**
   * Activation, two transactions signed in sequence:
   * 1. on the user's account: install the code, init, set the limit, add Inti's key;
   * 2. on the token: register the user and wrap `fundAmount` NEAR so orders can be funded.
   * Returns the transaction hashes.
   */
  async activate(accountId: string, signer: Signer, wasm: Uint8Array, limit: SpendLimit, fundAmount: bigint): Promise<string[]> {
    const account = this.account(accountId, signer);
    const { token, agentAccount } = this.config;
    if (agentAccount === null) throw new Error("Create your agent first.");
    const install = await account.signAndSendTransaction({
      receiverId: accountId,
      actions: [
        actions.deployContract(wasm),
        actions.functionCall("new", { intents: this.config.intentsAccount, agent: agentAccount }, 30n * TGAS, 0n),
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

  /**
   * "Turn off Inti": turn the wrapped NEAR back into NEAR, then remove Inti's key and replace
   * Spending Limits with an empty contract, which frees the code's storage. Everything stays as
   * plain NEAR in the user's account.
   */
  releasePlan(accountId: string, wrapped: bigint, intiConnected: boolean): OwnerTransaction[] {
    const plan: OwnerTransaction[] = [];
    if (wrapped > 0n) {
      plan.push({
        signerId: accountId,
        receiverId: this.config.token.id,
        actions: [actions.functionCall("near_withdraw", { amount: wrapped.toString() }, 30n * TGAS, 1n)],
      });
    }
    plan.push({
      signerId: accountId,
      receiverId: accountId,
      actions: [...(intiConnected ? [actions.deleteKey(PublicKey.fromString(this.config.intiPublicKey))] : []), actions.deployContract(EMPTY_CONTRACT)],
    });
    return plan;
  }

  /** Signs and sends the transactions in order, stopping at the first failure. Returns their hashes. */
  async send(accountId: string, signer: Signer, plan: readonly OwnerTransaction[]): Promise<string[]> {
    const account = this.account(accountId, signer);
    const hashes: string[] = [];
    for (const tx of plan) {
      const res = await account.signAndSendTransaction({ receiverId: tx.receiverId, actions: [...tx.actions] });
      hashes.push(res.transaction.hash);
    }
    return hashes;
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
