import { Account, JsonRpcProvider, PublicKey, actions } from "near-api-js";
import type { Action, Signer } from "near-api-js";
import { priceToMicro } from "../../../agent/core/money";
import { ASSET_KEYS, ASSETS, type AssetKey } from "../../../agent/policy/assets";
import type { LimitsConfig } from "./config";
import { assetContract, EMPTY_CONTRACT, isIntiShapedKey, wasmSha256, type OwnerTransaction } from "./ownerActions";

const TGAS = 10n ** 12n;
/** Storage staking rate: 1E19 yoctoNEAR per byte (docs.near.org/protocol/storage/storage-staking). */
const YOCTO_PER_BYTE = 10n ** 19n;
/** Code hash of an account with no contract. */
const NO_CODE = "11111111111111111111111111111111";
/** Room for contract state, token registration and gas on top of the code storage. */
const ACTIVATION_MARGIN = 10n ** 23n; // 0.1 NEAR
/** Room for creating the user's agent; the Agent API asks about 0.0145 NEAR to store its rules. */
export const AGENT_CREATION_RESERVE = 2n * 10n ** 22n; // 0.02 NEAR
/** NEAR left in the account when adding NEAR for orders, so the user and Inti's key can still pay network fees. */
export const FEE_RESERVE = 5n * 10n ** 22n; // 0.05 NEAR

export interface SpendLimit {
  perOrder: bigint;
  perDay: bigint;
}

/** USD prices of NEAR and each asset, as the dashboard reads them; null when there is no fresh price. */
export type LimitPrices = Record<"near" | AssetKey, number | null>;

const NEAR_DECIMALS = 24;

/**
 * The one limit the user sets, in NEAR, as the same value of each asset Inti may sell, at today's
 * prices. Each asset needs its own limit on chain; Inti's server also counts all of them against
 * the one daily limit. Refuses without a fresh price, so no asset is left without its limit.
 */
export function sellLimits(limit: SpendLimit, prices: LimitPrices): { token: string; limit: SpendLimit }[] {
  if (prices.near === null || ASSET_KEYS.some((k) => prices[k] === null)) throw new Error("Prices are not available right now. Try again in a minute.");
  const nearMicro = priceToMicro(prices.near);
  const scale = (atomicNear: bigint, key: AssetKey) =>
    (atomicNear * nearMicro * 10n ** BigInt(ASSETS[key].decimals)) / (priceToMicro(prices[key] ?? 0) * 10n ** BigInt(NEAR_DECIMALS));
  return ASSET_KEYS.map((key) => {
    // The contract needs a positive per-order limit, at most the daily one.
    const perDay = scale(limit.perDay, key) > 0n ? scale(limit.perDay, key) : 1n;
    const perOrder = scale(limit.perOrder, key);
    return { token: assetContract(key), limit: { perOrder: perOrder > 0n ? (perOrder < perDay ? perOrder : perDay) : 1n, perDay } };
  });
}

export type LimitsStatus =
  | { kind: "unfunded"; available: bigint }
  | { kind: "not-installed"; available: bigint }
  | {
      kind: "installed";
      available: bigint;
      intiConnected: boolean;
      /** NEAR Inti's key may still spend on network fees, in total; null without a key or a cap. */
      intiFeesLeft: bigint | null;
      agent: string;
      limit: SpendLimit | null;
      /** Whether the saved limits also cover selling; accounts set up before selling existed lack them. */
      sellsAllowed: boolean;
      spentToday: bigint;
      /** Token balance the agent can be funded from. */
      spendable: bigint;
      /** NEAR the network keeps aside for the Spending Limits code and the account's data. */
      setAside: bigint;
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
    const [onChainConfig, limit, sellLimits, spent, balance, intiKey] = await Promise.all([
      this.view<{ agent: string }>(accountId, "get_config"),
      this.view<{ per_order: string; per_day: string } | null>(accountId, "get_limit", { token }),
      // Selling is covered only when every tradable asset has its limit: an account saved before an
      // asset was added or replaced lacks that one, and the app asks to save the limits again.
      Promise.all(ASSET_KEYS.map((k) => this.view<unknown>(accountId, "get_limit", { token: assetContract(k) }))),
      this.view<string>(accountId, "get_spent_last_24h", { token }),
      this.view<string>(token, "ft_balance_of", { account_id: accountId }),
      this.intiKey(accountId),
    ]);
    return {
      kind: "installed",
      available,
      intiConnected: intiKey.connected,
      intiFeesLeft: intiKey.feesLeft,
      agent: onChainConfig.agent,
      limit: limit ? { perOrder: BigInt(limit.per_order), perDay: BigInt(limit.per_day) } : null,
      sellsAllowed: sellLimits.every((l) => l != null),
      spentToday: BigInt(spent),
      spendable: BigInt(balance),
      setAside: state.balance.usedOnStorage,
    };
  }

  /**
   * Whether Inti's key is on the account, and what it may still spend on network fees (null when
   * the key has no fee cap). The allowance is one total that each transaction lowers; adding the
   * key again starts it over.
   */
  private async intiKey(accountId: string): Promise<{ connected: boolean; feesLeft: bigint | null }> {
    let key;
    try {
      key = await new Account(accountId, this.provider).getAccessKey(this.config.intiPublicKey);
    } catch {
      return { connected: false, feesLeft: null };
    }
    const permission = key.permission as unknown;
    const allowance = typeof permission === "object" && permission !== null && "FunctionCall" in permission ? (permission as { FunctionCall: { allowance?: string | null } }).FunctionCall.allowance : null;
    return { connected: true, feesLeft: typeof allowance === "string" && /^\d+$/.test(allowance) ? BigInt(allowance) : null };
  }

  private account(accountId: string, signer: Signer): Account {
    return new Account(accountId, this.provider, signer);
  }

  /**
   * Inti keys from before the server's key changed: keys that may only call fund_agent on the
   * account, other than the current one. Pausing, resuming and turning off remove them too.
   */
  async earlierIntiKeys(accountId: string): Promise<string[]> {
    const list = await new Account(accountId, this.provider).getAccessKeyList();
    return list.keys
      .filter((k) => k.public_key !== this.config.intiPublicKey && isIntiShapedKey(k.access_key.permission, accountId))
      .map((k) => k.public_key);
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
  async activate(accountId: string, signer: Signer, wasm: Uint8Array, limit: SpendLimit, fundAmount: bigint, prices: LimitPrices): Promise<string[]> {
    const account = this.account(accountId, signer);
    const { token, agentAccount } = this.config;
    if (agentAccount === null) throw new Error("Create your agent first.");
    const install = await account.signAndSendTransaction({
      receiverId: accountId,
      actions: [
        actions.deployContract(wasm),
        actions.functionCall("new", { intents: this.config.intentsAccount, agent: agentAccount }, 30n * TGAS, 0n),
        ...this.limitActions(limit, prices),
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
  releasePlan(accountId: string, wrapped: bigint, intiConnected: boolean, earlierKeys: readonly string[] = []): OwnerTransaction[] {
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
      actions: [
        ...(intiConnected ? [actions.deleteKey(PublicKey.fromString(this.config.intiPublicKey))] : []),
        ...earlierKeys.map((k) => actions.deleteKey(PublicKey.fromString(k))),
        actions.deployContract(EMPTY_CONTRACT),
      ],
    });
    return plan;
  }

  /** Most NEAR the user can add for orders: the available balance minus the fee reserve. */
  static maxForOrders(available: bigint): bigint {
    return available > FEE_RESERVE ? available - FEE_RESERVE : 0n;
  }

  /** Wraps `amount` more NEAR so the agent can be funded from it. It stays in the user's account. */
  async addForOrders(accountId: string, signer: Signer, amount: bigint): Promise<string> {
    const res = await this.account(accountId, signer).signAndSendTransaction({
      receiverId: this.config.token.id,
      actions: [actions.functionCall("near_deposit", {}, 10n * TGAS, amount)],
    });
    return res.transaction.hash;
  }

  /** Turns `amount` of the NEAR set aside for orders back into plain NEAR in the user's wallet. Inti stays on. */
  async moveToWallet(accountId: string, signer: Signer, amount: bigint): Promise<string> {
    const res = await this.account(accountId, signer).signAndSendTransaction({
      receiverId: this.config.token.id,
      actions: [actions.functionCall("near_withdraw", { amount: amount.toString() }, 30n * TGAS, 1n)],
    });
    return res.transaction.hash;
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

  /** Saves the one limit: for buying with NEAR and, in the same transaction, for selling each asset. */
  async setLimit(accountId: string, signer: Signer, limit: SpendLimit, prices: LimitPrices): Promise<string> {
    const res = await this.account(accountId, signer).signAndSendTransaction({ receiverId: accountId, actions: this.limitActions(limit, prices) });
    return res.transaction.hash;
  }

  private limitActions(limit: SpendLimit, prices: LimitPrices): Action[] {
    // Six calls of 30 TGas stay well under the 300 TGas a transaction may use; unused gas is refunded.
    const call = (token: string, l: SpendLimit) => actions.functionCall("set_limit", limitArgs(token, l), 30n * TGAS, 1n);
    return [call(this.config.token.id, limit), ...sellLimits(limit, prices).map((s) => call(s.token, s.limit))];
  }

  async disconnectInti(accountId: string, signer: Signer): Promise<string> {
    const earlier = await this.earlierIntiKeys(accountId);
    const res = await this.account(accountId, signer).signAndSendTransaction({
      receiverId: accountId,
      actions: [actions.deleteKey(PublicKey.fromString(this.config.intiPublicKey)), ...earlier.map((k) => actions.deleteKey(PublicKey.fromString(k)))],
    });
    return res.transaction.hash;
  }

  async reconnectInti(accountId: string, signer: Signer): Promise<string> {
    const earlier = await this.earlierIntiKeys(accountId);
    const res = await this.account(accountId, signer).signAndSendTransaction({
      receiverId: accountId,
      actions: [...earlier.map((k) => actions.deleteKey(PublicKey.fromString(k))), this.intiKeyAction(accountId)],
    });
    return res.transaction.hash;
  }
}

function limitArgs(token: string, limit: SpendLimit) {
  return { token, per_order: limit.perOrder.toString(), per_day: limit.perDay.toString() };
}
