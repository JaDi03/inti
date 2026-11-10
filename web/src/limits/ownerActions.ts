import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { Action } from "near-api-js";
import { fromAtomic } from "../../../agent/policy/units";
import type { LimitsConfig } from "./config";

/**
 * The only transactions the app asks the user's full-access key to sign. Each one is
 * read back action by action and described in plain words for the user to confirm;
 * anything that is not on this list is refused before it reaches the wallet.
 */

/** Most a token may charge to register the user (wrap.near asks 0.00125 NEAR). */
const MAX_REGISTRATION_YOCTO = 10n ** 22n; // 0.01 NEAR
const NEAR_DECIMALS = 24;
/** Most the one-time storage of an agent's rules may cost. */
const MAX_AGENT_RULES_YOCTO = 5n * 10n ** 22n; // 0.05 NEAR
const AGENT_RULES_KEYS = ["locked", "version", "valid_until", "wallet_pubkey", "encrypted_data", "wallet_signature", "agent_policy_hash", "storage_refund_to"] as const;

export class RefusedSigningError extends Error {}

/** A request the user signs for someone else to send (the Agent API pays its network fee). */
export interface OwnerDelegate {
  senderId: string;
  receiverId: string;
  actions: readonly Action[];
}

export interface OwnerTransaction {
  signerId: string;
  receiverId: string;
  actions: readonly Action[];
}

export function wasmSha256(code: Uint8Array): string {
  return bytesToHex(sha256(code));
}

const near = (yocto: bigint) => `${fromAtomic(yocto.toString(), NEAR_DECIMALS)} NEAR`;

function refuse(reason: string): never {
  throw new RefusedSigningError(`Inti refused to sign: ${reason}`);
}

/** JSON args with exactly these keys, or a refusal. */
function argsOf(raw: Uint8Array, method: string, keys: readonly string[]): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    refuse(`${method} has arguments that are not JSON.`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) refuse(`${method} has unexpected arguments.`);
  const actual = Object.keys(parsed).sort();
  if (actual.join(",") !== [...keys].sort().join(",")) refuse(`${method} has unexpected arguments.`);
  return parsed as Record<string, unknown>;
}

function atomicArg(value: unknown, method: string): bigint {
  if (typeof value !== "string" || !/^\d+$/.test(value)) refuse(`${method} has an amount that is not a whole number.`);
  return BigInt(value);
}

/** One action on the user's own account, described in one or more lines; anything else is refused. */
function describeOwnAccountAction(action: Action, config: LimitsConfig, accountId: string): string | string[] {
  const { token } = config;
  if (action.deployContract) {
    const hash = wasmSha256(action.deployContract.code);
    if (hash !== config.wasmSha256) refuse("the contract code is not the expected Spending Limits build.");
    return `Install the Spending Limits contract on your account (expected build ${hash.slice(0, 12)}).`;
  }
  if (action.functionCall) {
    const { methodName, args, deposit } = action.functionCall;
    if (methodName === "new") {
      const a = argsOf(args, methodName, ["intents", "agent"]);
      const ownAgent = config.agentAccount !== null && a.agent === config.agentAccount;
      if (a.intents !== config.intentsAccount || !ownAgent || deposit !== 0n) refuse("the setup names another agent or verifier.");
      return `Set up Spending Limits so orders can only go to your agent (${config.agentAccount}).`;
    }
    if (methodName === "set_limit") {
      const a = argsOf(args, methodName, ["token", "per_order", "per_day"]);
      if (a.token !== token.id || deposit !== 1n) refuse("the limit is for another token or attaches a deposit.");
      const perOrder = fromAtomic(atomicArg(a.per_order, methodName).toString(), token.decimals);
      const perDay = fromAtomic(atomicArg(a.per_day, methodName).toString(), token.decimals);
      return `Set your limit: at most ${perOrder} ${token.symbol} per order and ${perDay} ${token.symbol} per day.`;
    }
    refuse(`the method ${methodName} is not one Inti uses.`);
  }
  if (action.addKey) {
    const { publicKey, accessKey } = action.addKey;
    const permission = accessKey.permission.functionCall;
    const isIntiKey =
      publicKey.toString() === config.intiPublicKey &&
      permission !== undefined &&
      permission.receiverId === accountId &&
      permission.methodNames.length === 1 &&
      permission.methodNames[0] === "fund_agent" &&
      permission.allowance === config.intiKeyAllowanceYocto;
    if (!isIntiKey) refuse("the key to add is not Inti's limited key.");
    // The allowance is a separate cap on network fees; saying it apart keeps it from reading as the spending limit.
    return [
      "Give Inti a key that can only call fund_agent: it can send to your agent only within the spending limits you set.",
      `That key can also use up to ${near(config.intiKeyAllowanceYocto)} of your balance to pay network fees. This is not a spending limit.`,
    ];
  }
  if (action.deleteKey) {
    if (action.deleteKey.publicKey.toString() !== config.intiPublicKey) refuse("the key to remove is not Inti's key.");
    return "Remove Inti's key from your account. Inti can no longer fund your agent.";
  }
  refuse(`the action ${action.enum} is not one Inti uses.`);
}

/** One action on the token contract, described; anything else is refused. */
function describeTokenAction(action: Action, config: LimitsConfig, accountId: string): string {
  const call = action.functionCall;
  if (!call) refuse(`the action ${action.enum} on the token is not one Inti uses.`);
  if (call.methodName === "storage_deposit") {
    const a = argsOf(call.args, call.methodName, ["account_id", "registration_only"]);
    if (a.account_id !== accountId || a.registration_only !== true) refuse("the token registration is for another account.");
    if (call.deposit > MAX_REGISTRATION_YOCTO) refuse("the token registration costs more than expected.");
    return `Register your account with ${config.token.id} (one-time fee ${near(call.deposit)}).`;
  }
  if (call.methodName === "near_deposit") {
    argsOf(call.args, call.methodName, []);
    return `Turn ${near(call.deposit)} into ${config.token.symbol} your agent can be funded from. It stays in your account.`;
  }
  refuse(`the method ${call.methodName} on the token is not one Inti uses.`);
}

/** The one call that creates an agent: storing its rules, unlocked, for a small one-time cost. */
function agentCreation(delegate: OwnerDelegate, config: LimitsConfig): { agentAccount: string; cost: bigint } {
  if (delegate.receiverId !== config.agentRulesContract) refuse(`the request is addressed to ${delegate.receiverId}.`);
  const call = delegate.actions.length === 1 ? delegate.actions[0]?.functionCall : undefined;
  if (!call) refuse("creating an agent is exactly one contract call.");
  if (call.methodName !== "store_wallet_policy") refuse(`the method ${call.methodName} is not one Inti uses.`);
  const a = argsOf(call.args, call.methodName, AGENT_RULES_KEYS);
  if (a.locked !== false) refuse("the agent's rules would be locked.");
  if (call.deposit > MAX_AGENT_RULES_YOCTO) refuse("creating the agent costs more than expected.");
  const key = /^ed25519:([0-9a-f]{64})$/.exec(typeof a.wallet_pubkey === "string" ? a.wallet_pubkey : "");
  if (!key?.[1]) refuse("the agent's key is not valid.");
  return { agentAccount: key[1], cost: call.deposit };
}

/** The agent account a creation request is for: the wallet key named in the rules it stores. */
export function agentAccountOf(delegate: OwnerDelegate, config: LimitsConfig): string {
  return agentCreation(delegate, config).agentAccount;
}

/**
 * Plain-language lines for the only request the app asks the user to sign for someone else to
 * send: creating their own agent. Anything else is refused.
 */
export function describeOwnerDelegate(delegate: OwnerDelegate, config: LimitsConfig): string[] {
  const { agentAccount, cost } = agentCreation(delegate, config);
  return [
    `Create your own agent on NEAR Intents (${agentAccount}).`,
    `Store its rules, encrypted, on ${config.agentRulesContract} (one-time cost ${near(cost)}).`,
  ];
}

/**
 * Plain-language lines for a transaction the app may sign with the user's full-access
 * key, or a RefusedSigningError when any part of it is not an action Inti uses.
 */
export function describeOwnerTransaction(tx: OwnerTransaction, config: LimitsConfig): string[] {
  const accountId = tx.signerId;
  if (tx.actions.length === 0) refuse("the transaction is empty.");
  if (tx.receiverId === accountId) return tx.actions.flatMap((action) => describeOwnAccountAction(action, config, accountId));
  if (tx.receiverId === config.token.id) return tx.actions.map((action) => describeTokenAction(action, config, accountId));
  return refuse(`the transaction is addressed to ${tx.receiverId}.`);
}
