import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { Action } from "near-api-js";
import { agentPolicy, PRICE_PROTECTION_BPS } from "../../../agent/policy/agentPolicy";
import { ASSET_KEYS, ASSETS, type AssetKey } from "../../../agent/policy/assets";
import { policyDifferences } from "../../../agent/policy/verify";
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

/** The smallest valid wasm module: replacing Spending Limits with it frees the code's storage. */
export const EMPTY_CONTRACT = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

const isEmptyContract = (code: Uint8Array) => code.length === EMPTY_CONTRACT.length && code.every((b, i) => b === EMPTY_CONTRACT[i]);

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
    if (isEmptyContract(action.deployContract.code)) {
      return "Remove Inti's setup from your account. The NEAR set aside for it goes back to your main balance.";
    }
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
      if (deposit !== 1n) refuse("the limit attaches a deposit.");
      if (a.token === token.id) {
        const perOrder = fromAtomic(atomicArg(a.per_order, methodName).toString(), token.decimals);
        const perDay = fromAtomic(atomicArg(a.per_day, methodName).toString(), token.decimals);
        return `Set your limit: at most ${perOrder} ${token.symbol} per order and ${perDay} ${token.symbol} per day.`;
      }
      // Selling limits: only for the assets Inti trades, never for any other token.
      const key = ASSET_KEYS.find((k) => assetContract(k) === a.token);
      if (!key) refuse("the limit is for a token Inti does not trade.");
      const { symbol, decimals } = ASSETS[key];
      const perOrder = fromAtomic(atomicArg(a.per_order, methodName).toString(), decimals);
      const perDay = fromAtomic(atomicArg(a.per_day, methodName).toString(), decimals);
      return `The same limit for selling ${ASSETS[key].name}: at most ${perOrder} ${symbol} per order and ${perDay} ${symbol} per day, checked on chain for this asset. Inti's server also keeps all buying and selling together within your one daily limit. What Inti sells always comes back to your wallet.`;
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
    return "Turn off Inti's access to your account.";
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
  if (call.methodName === "near_withdraw") {
    const a = argsOf(call.args, call.methodName, ["amount"]);
    const wrapped = atomicArg(a.amount, call.methodName);
    if (wrapped === 0n || call.deposit !== 1n) refuse("turning wrapped NEAR back needs a positive amount and exactly 1 yoctoNEAR.");
    return `Move ${fromAtomic(wrapped.toString(), config.token.decimals)} NEAR from Inti's trading balance back to your main balance.`;
  }
  if (call.methodName === "near_deposit") {
    argsOf(call.args, call.methodName, []);
    return `Turn ${near(call.deposit)} into ${config.token.symbol} your agent can be funded from. It stays in your account.`;
  }
  refuse(`the method ${call.methodName} on the token is not one Inti uses.`);
}

/** The token contract behind each asset the agent may buy. */
export function assetContract(key: AssetKey): string {
  return ASSETS[key].assetId.replace(/^nep141:/, "");
}

function assetByContract(contract: string): { key: AssetKey; name: string } | null {
  const key = ASSET_KEYS.find((k) => assetContract(k) === contract);
  return key ? { key, name: ASSETS[key].name } : null;
}

/** Enabling an asset: registering the user's own account with its token, so it can receive it. */
function describeAssetEnable(action: Action, name: string, accountId: string): string {
  const call = action.functionCall;
  if (call?.methodName !== "storage_deposit") refuse(`only enabling ${name} is allowed on its token.`);
  const a = argsOf(call.args, call.methodName, ["account_id", "registration_only"]);
  if (a.account_id !== accountId || a.registration_only !== true) refuse(`enabling ${name} is for another account.`);
  if (call.deposit > MAX_REGISTRATION_YOCTO) refuse(`enabling ${name} costs more than expected.`);
  return `Enable ${name} in your wallet so Inti can deliver it to you (one-time fee ${near(call.deposit)}).`;
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

/** The rules a freeze stores again, with the agent marked frozen: no refund account, unlike a creation. */
const FREEZE_RULES_KEYS = ["locked", "version", "valid_until", "wallet_pubkey", "encrypted_data", "wallet_signature", "agent_policy_hash"] as const;

/**
 * The agent account a freeze is for, or a refusal. A freeze is exactly two calls to the agent
 * rules contract, free of charge: store the rules (marked frozen) and freeze that same agent's
 * wallet. The rules themselves are encrypted, so the app also checks the Agent API's preview of
 * them before signing (see agent/freeze.ts).
 */
export function agentFreezeOf(delegate: OwnerDelegate, config: LimitsConfig): string {
  if (delegate.receiverId !== config.agentRulesContract) refuse(`the request is addressed to ${delegate.receiverId}.`);
  const [store, freeze] = delegate.actions.map((a) => a.functionCall);
  if (!store || !freeze || delegate.actions.length !== 2) refuse("freezing the agent is exactly two contract calls.");
  if (store.methodName !== "store_wallet_policy" || freeze.methodName !== "freeze_wallet") refuse(`the methods ${store.methodName} and ${freeze.methodName} are not a freeze.`);
  if (store.deposit !== 0n || freeze.deposit !== 0n) refuse("freezing the agent never costs anything.");
  const rules = argsOf(store.args, store.methodName, FREEZE_RULES_KEYS);
  if (rules.locked !== false) refuse("the agent's rules would be locked.");
  const target = argsOf(freeze.args, freeze.methodName, ["wallet_pubkey"]);
  const key = /^ed25519:([0-9a-f]{64})$/.exec(typeof rules.wallet_pubkey === "string" ? rules.wallet_pubkey : "");
  if (!key?.[1] || target.wallet_pubkey !== rules.wallet_pubkey) refuse("the freeze is not for one agent.");
  return key[1];
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
  if (delegate.actions.length === 2) {
    const agentAccount = agentFreezeOf(delegate, config);
    return [`Freeze your agent (${agentAccount}): it can do nothing until you unfreeze it.`, "Its money stays with it. Nothing is sent anywhere."];
  }
  const { agentAccount, cost } = agentCreation(delegate, config);
  return [
    `Create your own agent on NEAR Intents (${agentAccount}).`,
    `Store its rules, encrypted, on ${config.agentRulesContract} (one-time cost ${near(cost)}).`,
  ];
}

/** The one message the app signs: a grant that lets Inti's server act for the user's agent. */
export interface GrantMessage {
  message: string;
  recipient: string;
}

/**
 * A signed message's JSON, only when writing it back gives the very same text. The Agent API sends
 * compact JSON, so anything else (a key written twice, extra spaces) is refused: what the user sees
 * is then exactly what any reader of the message gets.
 */
function exactJson(message: string): Record<string, unknown> {
  const parsed = JSON.parse(message) as unknown;
  if (JSON.stringify(parsed) !== message) throw new SyntaxError("not exact JSON");
  return parsed as Record<string, unknown>;
}

const GRANT_DOMAIN = "near-intents-agent-api.agent-grant.v6";
export const GRANT_LABEL = "Inti trading";
/** Longest grant the app signs; Inti asks for 90 days. */
const MAX_GRANT_MS = 91 * 86_400_000;
const GRANT_KEYS = ["agent_id", "credential", "domain", "expires_at_ms", "issued_at_ms", "label", "network", "nonce", "owner", "owner_epoch", "recipient", "tenant_id", "wallet_id"];

/**
 * Plain-language lines for a grant, or a refusal when the message is anything else: another
 * domain or network, another owner, another service, or longer than Inti asks for.
 */
export function describeGrant(grant: GrantMessage, accountId: string, publicKey: string, config: LimitsConfig, now: number): string[] {
  let m: Record<string, unknown>;
  try {
    m = exactJson(grant.message);
  } catch {
    refuse("the message is not a grant.");
  }
  if (typeof m !== "object" || m === null || Object.keys(m).sort().join(",") !== GRANT_KEYS.join(",")) refuse("the message is not a grant.");
  if (m.domain !== GRANT_DOMAIN || m.network !== "mainnet") refuse("the message is not a mainnet grant.");
  if (grant.recipient !== config.agentApiHost || m.recipient !== config.agentApiHost) refuse(`the grant is for ${String(m.recipient)}.`);
  const owner = m.owner as Record<string, unknown> | null;
  if (owner?.type !== "near" || owner.account_id !== accountId || owner.public_key !== publicKey) refuse("the grant names another owner.");
  if (m.label !== GRANT_LABEL) refuse("the grant is not Inti's.");
  if (typeof m.agent_id !== "string" || !/^[0-9a-f]{64}$/.test(m.agent_id)) refuse("the grant names no agent.");
  if (typeof m.credential !== "string" || !/^[0-9a-f]{64}$/.test(m.credential)) refuse("the grant has no valid credential.");
  const expires = m.expires_at_ms;
  if (typeof expires !== "number" || expires <= now || expires - now > MAX_GRANT_MS) refuse("the grant lasts longer than Inti asks for.");
  const until = new Date(expires).toISOString().slice(0, 10);
  return [
    `Let Inti trade for your agent until ${until}, without asking you each time.`,
    "It can only buy and sell within the spending limits you set, and everything it buys or sells for goes to your wallet.",
    "You can turn it off at any time.",
  ];
}

const OWNER_ADMIN_DOMAIN = "near-intents-agent-api.owner-admin.v2";
const POLICY_UPDATE_KEYS = ["action", "agent_id", "domain", "expected_revision", "expires_at_ms", "issued_at_ms", "network", "nonce", "owner", "owner_epoch", "policy", "recipient", "target_id", "tenant_id"];
/** Longest a rule change may stay signable; the Agent API gives five minutes. */
const MAX_POLICY_UPDATE_MS = 10 * 60_000;

/**
 * Plain-language lines for a change of the agent's rules, or a refusal unless the new rules are
 * exactly the ones every Inti agent has, with one of the price protections the user can pick.
 */
export function describePolicyUpdate(update: GrantMessage, accountId: string, publicKey: string, config: LimitsConfig, now: number): string[] {
  let m: Record<string, unknown>;
  try {
    m = exactJson(update.message);
  } catch {
    refuse("the message is not a rule change.");
  }
  if (typeof m !== "object" || m === null || Object.keys(m).sort().join(",") !== POLICY_UPDATE_KEYS.join(",")) refuse("the message is not a rule change.");
  if (m.action !== "update_policy" || m.domain !== OWNER_ADMIN_DOMAIN || m.network !== "mainnet") refuse("the message is not a mainnet rule change.");
  if (update.recipient !== config.agentApiHost || m.recipient !== config.agentApiHost) refuse(`the rule change is for ${String(m.recipient)}.`);
  const owner = m.owner as Record<string, unknown> | null;
  if (owner?.type !== "near" || owner.account_id !== accountId || owner.public_key !== publicKey) refuse("the rule change names another owner.");
  if (typeof m.agent_id !== "string" || !/^[0-9a-f]{64}$/.test(m.agent_id)) refuse("the rule change names no agent.");
  const expires = m.expires_at_ms;
  if (typeof expires !== "number" || expires <= now || expires - now > MAX_POLICY_UPDATE_MS) refuse("the rule change has expired.");
  const bps = PRICE_PROTECTION_BPS.find((b) => policyDifferences(agentPolicy(accountId, b), m.policy).length === 0);
  if (bps === undefined) refuse("the new rules are not the ones Inti uses.");
  const percent = bps / 100;
  return [
    `Set your price protection to ${percent}%.`,
    `Price orders stay within ${percent}% of the market, and a buy now never gets more than ${percent}% less than its quote.`,
    "Nothing else changes: your agent still sends only to your own wallet.",
  ];
}

const GRANT_REVOKE_KEYS = ["action", "agent_id", "domain", "expires_at_ms", "issued_at_ms", "network", "nonce", "owner", "owner_epoch", "recipient", "target_id", "tenant_id"];

/**
 * Plain-language lines for closing one earlier grant of the user's agent. Closing only takes a
 * permission away, but the message must still be the user's own, for this service, on mainnet.
 */
export function describeGrantRevoke(revoke: GrantMessage, accountId: string, publicKey: string, config: LimitsConfig, now: number): string[] {
  let m: Record<string, unknown>;
  try {
    m = exactJson(revoke.message);
  } catch {
    refuse("the message is not a grant closing.");
  }
  if (typeof m !== "object" || m === null || Object.keys(m).sort().join(",") !== GRANT_REVOKE_KEYS.join(",")) refuse("the message is not a grant closing.");
  if (m.action !== "revoke_grant" || m.domain !== OWNER_ADMIN_DOMAIN || m.network !== "mainnet") refuse("the message is not a mainnet grant closing.");
  if (revoke.recipient !== config.agentApiHost || m.recipient !== config.agentApiHost) refuse(`the grant closing is for ${String(m.recipient)}.`);
  const owner = m.owner as Record<string, unknown> | null;
  if (owner?.type !== "near" || owner.account_id !== accountId || owner.public_key !== publicKey) refuse("the grant closing names another owner.");
  if (typeof m.agent_id !== "string" || !/^[0-9a-f]{64}$/.test(m.agent_id)) refuse("the grant closing names no agent.");
  if (typeof m.target_id !== "string" || !/^[0-9a-f]{64}$/.test(m.target_id)) refuse("the grant closing names no grant.");
  const expires = m.expires_at_ms;
  if (typeof expires !== "number" || expires <= now || expires - now > MAX_POLICY_UPDATE_MS) refuse("the grant closing has expired.");
  return ["Close Inti's earlier permission, so only the new one stays."];
}

/** Plain-language lines for the only messages the app signs: a grant, closing an earlier one, or a price protection change. */
export function describeOwnerMessage(message: GrantMessage, accountId: string, publicKey: string, config: LimitsConfig, now: number): string[] {
  if (!message.message.includes(`"domain":"${OWNER_ADMIN_DOMAIN}"`)) return describeGrant(message, accountId, publicKey, config, now);
  return message.message.includes(`"action":"revoke_grant"`)
    ? describeGrantRevoke(message, accountId, publicKey, config, now)
    : describePolicyUpdate(message, accountId, publicKey, config, now);
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
  const asset = assetByContract(tx.receiverId);
  if (asset) return tx.actions.map((action) => describeAssetEnable(action, asset.name, accountId));
  return refuse(`the transaction is addressed to ${tx.receiverId}.`);
}
