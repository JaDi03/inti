import { readFileSync } from "node:fs";
import { Account, actions, buildDelegateAction, createTransaction, KeyPair } from "near-api-js";
import type { Action, KeyPairEd25519 } from "near-api-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentPolicy } from "../../../agent/policy/agentPolicy";
import { PrivyNearSigner, type SignRawHash } from "../privySigner";
import { LimitsClient } from "./client";
import { SPENDING_LIMITS_WASM_SHA256, type LimitsConfig } from "./config";
import { agentAccountOf, agentFreezeOf, assetContract, EMPTY_CONTRACT, RefusedSigningError, wasmSha256 } from "./ownerActions";
import { OwnerSigner, SigningCancelledError } from "./ownerSigner";

const expectedWasm = new Uint8Array(readFileSync(new URL("../../public/inti-spending-limits.wasm", import.meta.url)));
const intiKey = KeyPair.fromRandom("ed25519").getPublicKey();

const config: LimitsConfig = {
  rpcUrl: "http://127.0.0.1:1",
  explorerTxUrl: (hash) => hash,
  intentsAccount: "intents.testnet",
  agentAccount: "agent.testnet",
  agentRulesContract: "outlayer.near",
  token: { id: "wrap.testnet", symbol: "NEAR", decimals: 24 },
  intiPublicKey: intiKey.toString(),
  intiKeyAllowanceYocto: 10n ** 23n,
  wasmUrl: "/inti-spending-limits.wasm",
  wasmSha256: SPENDING_LIMITS_WASM_SHA256,
  agentApiHost: "api.demo.agentsonintents.com",
};

/** A user wallet whose key really signs, plus a record of every hash it was asked to sign. */
function userWallet(answer = true, hasPasskey = true) {
  const keyPair = KeyPair.fromRandom("ed25519") as KeyPairEd25519;
  const publicKey = keyPair.getPublicKey();
  const accountId = Buffer.from(publicKey.data).toString("hex");
  const signed: string[] = [];
  const signRawHash: SignRawHash = ({ hash }) => {
    signed.push(hash);
    const signature = keyPair.sign(Buffer.from(hash.slice(2), "hex")).signature;
    return Promise.resolve({ signature: `0x${Buffer.from(signature).toString("hex")}` });
  };
  const shown: string[][] = [];
  const confirm = (lines: string[]) => {
    shown.push(lines);
    return Promise.resolve(answer);
  };
  const signer = new OwnerSigner(new PrivyNearSigner(accountId, signRawHash), config, confirm, () => hasPasskey);
  return { publicKey, accountId, signed, shown, signer };
}

type Wallet = ReturnType<typeof userWallet>;

/** Prices from the Agent API token list. */
const PRICES = { near: 3.55, bitcoin: 73948, ethereum: 2056.35, zcash: 956.27 };
const BTC_SELL_LINE = (perOrder: string, perDay: string) =>
  `The same limit for selling Bitcoin: at most ${perOrder} BTC per order and ${perDay} BTC per day, checked on chain for this asset. Inti's server also keeps all buying and selling together within your one daily limit. What Inti sells always comes back to your wallet.`;

function sign(wallet: Wallet, receiverId: string, txActions: Action[]) {
  return wallet.signer.signTransaction(createTransaction(wallet.accountId, wallet.publicKey, receiverId, 1n, txActions, new Uint8Array(32)));
}

/** Runs the client's real methods; each transaction goes through the owner signer. */
function clientSigningThrough(wallet: Wallet) {
  vi.spyOn(Account.prototype, "signAndSendTransaction").mockImplementation(async (params) => {
    await sign(wallet, params.receiverId, params.actions);
    return { transaction: { hash: "tx" } } as never;
  });
  const client = new LimitsClient(config);
  vi.spyOn(client.provider, "callFunction").mockResolvedValue({ min: "1250000000000000000000" } as never);
  return client;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("signing with the user's account key", () => {
  it("activation shows both transactions in plain words and signs them after the user confirms", async () => {
    const wallet = userWallet();
    const client = clientSigningThrough(wallet);
    await client.activate(wallet.accountId, wallet.signer, expectedWasm, { perOrder: 10n ** 24n, perDay: 3n * 10n ** 24n }, 10n ** 23n, PRICES);

    expect(wallet.signed).toHaveLength(2);
    expect(wallet.shown).toHaveLength(2);
    // One NEAR (3.55 dollars) is 0.000048 BTC at 73948 dollars, rounded down.
    expect(wallet.shown[0]?.slice(0, 4)).toEqual([
      `Install the Spending Limits contract on your account (expected build ${SPENDING_LIMITS_WASM_SHA256.slice(0, 12)}).`,
      "Set up Spending Limits so orders can only go to your agent (agent.testnet).",
      "Set your limit: at most 1 NEAR per order and 3 NEAR per day.",
      BTC_SELL_LINE("0.000048", "0.00014402"),
    ]);
    expect(wallet.shown[0]).toHaveLength(8);
    expect(wallet.shown[0]?.slice(-2)).toEqual([
      "Give Inti a key that can only call fund_agent: it can send to your agent only within the spending limits you set.",
      "That key can also use up to 0.1 NEAR of your balance to pay network fees. This is not a spending limit.",
    ]);
    expect(wallet.shown[1]).toEqual([
      "Register your account with wrap.testnet (one-time fee 0.00125 NEAR).",
      "Turn 0.1 NEAR into NEAR your agent can be funded from. It stays in your account.",
    ]);
  });

  it("changing the limit, disconnecting and reconnecting Inti are signed after confirming", async () => {
    const wallet = userWallet();
    const client = clientSigningThrough(wallet);
    await client.setLimit(wallet.accountId, wallet.signer, { perOrder: 5n * 10n ** 23n, perDay: 10n ** 24n }, PRICES);
    await client.disconnectInti(wallet.accountId, wallet.signer);
    await client.reconnectInti(wallet.accountId, wallet.signer);

    expect(wallet.signed).toHaveLength(3);
    expect(wallet.shown[0]?.slice(0, 2)).toEqual(["Set your limit: at most 0.5 NEAR per order and 1 NEAR per day.", BTC_SELL_LINE("0.000024", "0.000048")]);
    expect(wallet.shown[0]).toHaveLength(4);
    expect(wallet.shown.slice(1)).toEqual([
      ["Turn off Inti's access to your account."],
      [
        "Give Inti a key that can only call fund_agent: it can send to your agent only within the spending limits you set.",
        "That key can also use up to 0.1 NEAR of your balance to pay network fees. This is not a spending limit.",
      ],
    ]);
  });

  it("saves no limit at all without a fresh price for every asset", async () => {
    const wallet = userWallet();
    const client = clientSigningThrough(wallet);
    await expect(client.setLimit(wallet.accountId, wallet.signer, { perOrder: 1n, perDay: 2n }, { ...PRICES, zcash: null })).rejects.toThrow("Prices are not available");
    expect(wallet.shown).toHaveLength(0);
    expect(wallet.signed).toHaveLength(0);
  });

  it("nothing is signed when the user cancels", async () => {
    const wallet = userWallet(false);
    const client = clientSigningThrough(wallet);
    await expect(client.setLimit(wallet.accountId, wallet.signer, { perOrder: 1n, perDay: 2n }, PRICES)).rejects.toThrow(SigningCancelledError);
    expect(wallet.shown).toHaveLength(1);
    expect(wallet.signed).toHaveLength(0);
  });

  it("signs nothing and shows no dialog while the account has no second factor", async () => {
    const wallet = userWallet(true, false);
    const client = clientSigningThrough(wallet);
    await expect(client.setLimit(wallet.accountId, wallet.signer, { perOrder: 1n, perDay: 2n }, PRICES)).rejects.toThrow("protect your account");
    expect(wallet.shown).toHaveLength(0);
    expect(wallet.signed).toHaveLength(0);
  });

  const refused: [string, (w: Wallet) => [string, Action[]]][] = [
    ["moving all funds and adding a stranger's full-access key", (w) => [w.accountId, [actions.transfer(10n ** 30n), actions.addFullAccessKey(KeyPair.fromRandom("ed25519").getPublicKey())]]],
    ["a plain NEAR transfer", (w) => [w.accountId, [actions.transfer(1n)]]],
    ["deleting the account", (w) => [w.accountId, [actions.deleteAccount("stranger.testnet")]]],
    ["deploying code that is not the expected build", (w) => [w.accountId, [actions.deployContract(new TextEncoder().encode("any other contract"))]]],
    ["adding Inti's key with more methods", (w) => [w.accountId, [actions.addFunctionCallAccessKey(intiKey, w.accountId, ["fund_agent", "set_limit"], config.intiKeyAllowanceYocto)]]],
    ["adding Inti's key for another contract", (w) => [w.accountId, [actions.addFunctionCallAccessKey(intiKey, "other.testnet", ["fund_agent"], config.intiKeyAllowanceYocto)]]],
    ["adding Inti's key with a larger allowance", (w) => [w.accountId, [actions.addFunctionCallAccessKey(intiKey, w.accountId, ["fund_agent"], 10n ** 25n)]]],
    ["adding a stranger's function-call key", (w) => [w.accountId, [actions.addFunctionCallAccessKey(KeyPair.fromRandom("ed25519").getPublicKey(), w.accountId, ["fund_agent"], config.intiKeyAllowanceYocto)]]],
    ["deleting another key", (w) => [w.accountId, [actions.deleteKey(w.publicKey)]]],
    ["setup with another agent", (w) => [w.accountId, [actions.functionCall("new", { intents: config.intentsAccount, agent: "stranger.testnet" }, 1n, 0n)]]],
    ["a limit with an extra argument", (w) => [w.accountId, [actions.functionCall("set_limit", { token: "wrap.testnet", per_order: "1", per_day: "2", agent: "x" }, 1n, 1n)]]],
    ["a limit on another token", (w) => [w.accountId, [actions.functionCall("set_limit", { token: "usdc.testnet", per_order: "1", per_day: "2" }, 1n, 1n)]]],
    ["a selling limit with no yoctoNEAR attached", (w) => [w.accountId, [actions.functionCall("set_limit", { token: assetContract("zcash"), per_order: "1", per_day: "2" }, 1n, 0n)]]],
    ["a selling limit with an extra argument", (w) => [w.accountId, [actions.functionCall("set_limit", { token: assetContract("zcash"), per_order: "1", per_day: "2", to: "x" }, 1n, 1n)]]],
    ["a selling limit that is not a whole number", (w) => [w.accountId, [actions.functionCall("set_limit", { token: assetContract("zcash"), per_order: "1.5", per_day: "2" }, 1n, 1n)]]],
    ["a method Inti does not use", (w) => [w.accountId, [actions.functionCall("set_agent", { agent: "stranger.testnet" }, 1n, 1n)]]],
    ["a token transfer out", () => [config.token.id, [actions.functionCall("ft_transfer", { receiver_id: "stranger.testnet", amount: "1" }, 1n, 1n)]]],
    ["registering another account on the token", () => [config.token.id, [actions.functionCall("storage_deposit", { account_id: "stranger.testnet", registration_only: true }, 1n, 1n)]]],
    ["a registration that costs more than expected", (w) => [config.token.id, [actions.functionCall("storage_deposit", { account_id: w.accountId, registration_only: true }, 1n, 10n ** 24n)]]],
    ["a transaction to another contract", () => ["stranger.testnet", [actions.functionCall("anything", {}, 1n, 0n)]]],
    ["an empty transaction", (w) => [w.accountId, []]],
  ];

  it.each(refused)("refuses %s before asking the user or the wallet", async (_name, build) => {
    const wallet = userWallet();
    const [receiverId, txActions] = build(wallet);
    await expect(sign(wallet, receiverId, txActions)).rejects.toThrow(RefusedSigningError);
    expect(wallet.shown).toHaveLength(0);
    expect(wallet.signed).toHaveLength(0);
  });

  it("refuses a transaction that mixes an allowed action with one that is not", async () => {
    const wallet = userWallet();
    await expect(sign(wallet, wallet.accountId, [actions.deleteKey(intiKey), actions.transfer(1n)])).rejects.toThrow(RefusedSigningError);
    expect(wallet.signed).toHaveLength(0);
  });

  it("enables an asset only by registering the user's own account with that asset's token", async () => {
    const wallet = userWallet();
    const zcash = assetContract("zcash");
    const register = (account: string, deposit = 1_250_000_000_000_000_000_000n) =>
      actions.functionCall("storage_deposit", { account_id: account, registration_only: true }, 10n ** 13n, deposit);
    await sign(wallet, zcash, [register(wallet.accountId)]);
    expect(wallet.shown[0]).toEqual(["Enable Zcash in your wallet so Inti can deliver it to you (one-time fee 0.00125 NEAR)."]);

    await expect(sign(wallet, zcash, [register("cd".repeat(32))])).rejects.toThrow(RefusedSigningError);
    await expect(sign(wallet, zcash, [register(wallet.accountId, 10n ** 23n)])).rejects.toThrow(RefusedSigningError);
    await expect(sign(wallet, zcash, [actions.functionCall("ft_transfer", { receiver_id: "attacker.near", amount: "1" }, 10n ** 13n, 1n)])).rejects.toThrow(RefusedSigningError);
    await expect(sign(wallet, "usdt.tether-token.near", [register(wallet.accountId)])).rejects.toThrow(RefusedSigningError);
    expect(wallet.signed).toHaveLength(1);
  });

  /** A grant message shaped exactly like the Agent API's (fields read from a live grant_issue). */
  function grant(wallet: Wallet, changes: Record<string, unknown> = {}) {
    const now = Date.now();
    const message = {
      agent_id: "ab".repeat(32),
      credential: "cd".repeat(32),
      domain: "near-intents-agent-api.agent-grant.v6",
      expires_at_ms: now + 90 * 86_400_000,
      issued_at_ms: now,
      label: "Inti trading",
      network: "mainnet",
      nonce: "ef".repeat(32),
      owner: { account_id: wallet.accountId, public_key: wallet.publicKey.toString(), type: "near" },
      owner_epoch: 1,
      recipient: config.agentApiHost,
      tenant_id: "01".repeat(32),
      wallet_id: "685aeccf-ee19-4b46-b1c7-292d96870202",
      ...changes,
    };
    return { message: JSON.stringify(message), recipient: config.agentApiHost, nonce: new Uint8Array(32) };
  }

  it("signs a grant for the user's own agent after showing it in plain words", async () => {
    const wallet = userWallet();
    const signed = await wallet.signer.signNep413Message(wallet.accountId, grant(wallet));
    expect(signed.publicKey.toString()).toBe(wallet.publicKey.toString());
    expect(signed.signature).toHaveLength(64);
    expect(wallet.signed).toHaveLength(1);
    expect(wallet.shown[0]?.[0]).toMatch(/^Let Inti trade for your agent until \d{4}-\d{2}-\d{2}/);
  });

  it.each([
    ["another domain", { domain: "near-intents-agent-api.approval.v1" }],
    ["testnet", { network: "testnet" }],
    ["another owner", { owner: { account_id: "cd".repeat(32), public_key: "ed25519:x", type: "near" } }],
    ["another service", { recipient: "evil.example" }],
    ["another label", { label: "Something else" }],
    ["a year-long grant", { expires_at_ms: Date.now() + 365 * 86_400_000 }],
    ["an expired grant", { expires_at_ms: Date.now() - 1000 }],
    ["an extra field", { transfer_to: "attacker.near" }],
  ])("refuses a message with %s", async (_name, changes) => {
    const wallet = userWallet();
    await expect(wallet.signer.signNep413Message(wallet.accountId, grant(wallet, changes))).rejects.toThrow(RefusedSigningError);
    expect(wallet.signed).toHaveLength(0);
  });

  it("refuses any other message, a redirect, or a grant addressed to another host", async () => {
    const wallet = userWallet();
    const nonce = new Uint8Array(32);
    await expect(wallet.signer.signNep413Message(wallet.accountId, { message: "hello", recipient: config.agentApiHost, nonce })).rejects.toThrow(RefusedSigningError);
    await expect(wallet.signer.signNep413Message(wallet.accountId, { ...grant(wallet), callbackUrl: "https://evil.example" })).rejects.toThrow(RefusedSigningError);
    await expect(wallet.signer.signNep413Message(wallet.accountId, { ...grant(wallet), recipient: "evil.example" })).rejects.toThrow(RefusedSigningError);
    expect(wallet.signed).toHaveLength(0);
  });

  it("does not sign a grant the user cancels, or before a second factor is set", async () => {
    const cancelled = userWallet(false);
    await expect(cancelled.signer.signNep413Message(cancelled.accountId, grant(cancelled))).rejects.toThrow(SigningCancelledError);
    const unprotected = userWallet(true, false);
    await expect(unprotected.signer.signNep413Message(unprotected.accountId, grant(unprotected))).rejects.toThrow(RefusedSigningError);
    expect([...cancelled.signed, ...unprotected.signed]).toHaveLength(0);
  });
});

describe("renewing the grant", () => {
  /** A grant closing shaped exactly like the Agent API's (fields read from a live grant_revoke). */
  function closing(wallet: Wallet, changes: Record<string, unknown> = {}) {
    const now = Date.now();
    const message = {
      action: "revoke_grant",
      agent_id: "ab".repeat(32),
      domain: "near-intents-agent-api.owner-admin.v2",
      expires_at_ms: now + 300_000,
      issued_at_ms: now,
      network: "mainnet",
      nonce: "ef".repeat(32),
      owner: { account_id: wallet.accountId, public_key: wallet.publicKey.toString(), type: "near" },
      owner_epoch: 1,
      recipient: config.agentApiHost,
      target_id: "46".repeat(32),
      tenant_id: "01".repeat(32),
      ...changes,
    };
    return { message: JSON.stringify(message), recipient: config.agentApiHost, nonce: new Uint8Array(32) };
  }
  const grantFor = (wallet: Wallet) => {
    const now = Date.now();
    const message = {
      agent_id: "ab".repeat(32),
      credential: "cd".repeat(32),
      domain: "near-intents-agent-api.agent-grant.v6",
      expires_at_ms: now + 7 * 86_400_000,
      issued_at_ms: now,
      label: "Inti trading",
      network: "mainnet",
      nonce: "ef".repeat(32),
      owner: { account_id: wallet.accountId, public_key: wallet.publicKey.toString(), type: "near" },
      owner_epoch: 1,
      recipient: config.agentApiHost,
      tenant_id: "01".repeat(32),
      wallet_id: "685aeccf-ee19-4b46-b1c7-292d96870202",
    };
    return { message: JSON.stringify(message), recipient: config.agentApiHost, nonce: new Uint8Array(32) };
  };

  it("shows the new grant and the closing in one confirmation, then signs both without asking again", async () => {
    const wallet = userWallet();
    const grant = grantFor(wallet);
    const close = closing(wallet);
    await wallet.signer.approveMessages(wallet.accountId, [grant, close]);
    await wallet.signer.signNep413Message(wallet.accountId, grant);
    await wallet.signer.signNep413Message(wallet.accountId, close);
    expect(wallet.shown).toHaveLength(1);
    expect(wallet.shown[0]?.at(-1)).toBe("Close Inti's earlier permission, so only the new one stays.");
    expect(wallet.signed).toHaveLength(2);
  });

  it("asks again for a message that is not the one approved, or the same text with another nonce", async () => {
    const wallet = userWallet();
    await wallet.signer.approveMessages(wallet.accountId, [grantFor(wallet)]);
    await wallet.signer.signNep413Message(wallet.accountId, closing(wallet));
    expect(wallet.shown).toHaveLength(2);

    const again = userWallet();
    const grant = grantFor(again);
    await again.signer.approveMessages(again.accountId, [grant]);
    await again.signer.signNep413Message(again.accountId, { ...grant, nonce: new Uint8Array(32).fill(9) });
    expect(again.shown).toHaveLength(2);
  });

  it("refuses a message that is not written exactly as the Agent API writes it", async () => {
    const wallet = userWallet();
    const grant = grantFor(wallet);
    const spaced = { ...grant, message: JSON.stringify(JSON.parse(grant.message), null, 1) };
    // A key written twice: a reader that keeps the first one would see another owner.
    const twice = { ...grant, message: grant.message.replace("{", `{"owner":{"account_id":"${"cd".repeat(32)}","public_key":"ed25519:x","type":"near"},`) };
    await expect(wallet.signer.signNep413Message(wallet.accountId, spaced)).rejects.toThrow(RefusedSigningError);
    await expect(wallet.signer.signNep413Message(wallet.accountId, twice)).rejects.toThrow(RefusedSigningError);
    expect(wallet.signed).toHaveLength(0);
  });

  it.each([
    ["another owner", { owner: { account_id: "cd".repeat(32), public_key: "ed25519:x", type: "near" } }],
    ["another service", { recipient: "evil.example" }],
    ["testnet", { network: "testnet" }],
    ["no grant", { target_id: "x" }],
    ["an expired closing", { expires_at_ms: Date.now() - 1000 }],
    ["an extra field", { policy: {} }],
  ])("refuses a closing with %s", async (_name, changes) => {
    const wallet = userWallet();
    await expect(wallet.signer.signNep413Message(wallet.accountId, closing(wallet, changes))).rejects.toThrow(RefusedSigningError);
    await expect(wallet.signer.approveMessages(wallet.accountId, [grantFor(wallet), closing(wallet, changes)])).rejects.toThrow(RefusedSigningError);
    expect(wallet.shown).toHaveLength(0);
    expect(wallet.signed).toHaveLength(0);
  });
});

describe("changing the price protection", () => {
  /** A rule change shaped exactly like the Agent API's (fields read from a live policy_update). */
  function ruleChange(wallet: Wallet, changes: Record<string, unknown> = {}) {
    const now = Date.now();
    const message = {
      action: "update_policy",
      agent_id: "ab".repeat(32),
      domain: "near-intents-agent-api.owner-admin.v2",
      expected_revision: 1,
      expires_at_ms: now + 300_000,
      issued_at_ms: now,
      network: "mainnet",
      nonce: "ef".repeat(32),
      owner: { account_id: wallet.accountId, public_key: wallet.publicKey.toString(), type: "near" },
      owner_epoch: 1,
      policy: agentPolicy(wallet.accountId, 100),
      recipient: config.agentApiHost,
      target_id: "9d".repeat(32),
      tenant_id: "01".repeat(32),
      ...changes,
    };
    return { message: JSON.stringify(message), recipient: config.agentApiHost, nonce: new Uint8Array(32) };
  }

  it("signs Inti's own rules with a price protection the user can pick, after showing it", async () => {
    const wallet = userWallet();
    await wallet.signer.signNep413Message(wallet.accountId, ruleChange(wallet));
    expect(wallet.signed).toHaveLength(1);
    expect(wallet.shown[0]?.[0]).toBe("Set your price protection to 1%.");
  });

  it.each([
    ["rules that send anywhere", (w: Wallet) => ({ policy: { ...agentPolicy(w.accountId, 100), destinations: { mode: "any", list: [] } } })],
    ["rules that send to someone else", () => ({ policy: agentPolicy("cd".repeat(32), 100) })],
    ["a price protection Inti does not offer", (w: Wallet) => ({ policy: { ...agentPolicy(w.accountId), limit_order: { max_deviation_bps: 250 } } })],
    ["rules with an extra field", (w: Wallet) => ({ policy: { ...agentPolicy(w.accountId, 100), owner_approval: true } })],
    ["another action", () => ({ action: "freeze" })],
    ["another owner", () => ({ owner: { account_id: "cd".repeat(32), public_key: "ed25519:x", type: "near" } })],
    ["another service", () => ({ recipient: "evil.example" })],
    ["testnet", () => ({ network: "testnet" })],
    ["an expired change", () => ({ expires_at_ms: Date.now() - 1000 })],
    ["a change that stays signable for a day", () => ({ expires_at_ms: Date.now() + 86_400_000 })],
    ["an extra field", () => ({ transfer_to: "attacker.near" })],
  ])("refuses %s before asking the user or the wallet", async (_name, changes) => {
    const wallet = userWallet();
    await expect(wallet.signer.signNep413Message(wallet.accountId, ruleChange(wallet, changes(wallet)))).rejects.toThrow(RefusedSigningError);
    expect(wallet.shown).toHaveLength(0);
    expect(wallet.signed).toHaveLength(0);
  });
});

describe("creating the user's own agent", () => {
  const AGENT = "80".repeat(32);
  // The arguments the Agent API sends for a new agent.
  const rules = {
    locked: false,
    version: 1,
    valid_until: 1794881635,
    wallet_pubkey: `ed25519:${AGENT}`,
    encrypted_data: "AYHD",
    wallet_signature: "d9".repeat(64),
    agent_policy_hash: "62".repeat(32),
    storage_refund_to: "cf".repeat(32),
  };
  const COST = 12_910_000_000_000_000_000_000n;

  function creation(wallet: Wallet, receiverId = "outlayer.near", txActions: Action[] = [actions.functionCall("store_wallet_policy", rules, 10n ** 14n, COST)]) {
    return buildDelegateAction({ senderId: wallet.accountId, receiverId, actions: txActions, nonce: 1n, maxBlockHeight: 1n, publicKey: wallet.publicKey });
  }

  it("shows the agent and its cost in plain words and signs after the user confirms", async () => {
    const wallet = userWallet();
    const { signedDelegate } = await wallet.signer.signDelegateAction(creation(wallet));
    expect(wallet.shown).toEqual([
      [`Create your own agent on NEAR Intents (${AGENT}).`, "Store its rules, encrypted, on outlayer.near (one-time cost 0.01291 NEAR)."],
    ]);
    expect(wallet.signed).toHaveLength(1);
    expect(agentAccountOf(signedDelegate.delegateAction, config)).toBe(AGENT);
  });

  it("signs nothing when the user cancels or the account has no second factor", async () => {
    const cancelled = userWallet(false);
    await expect(cancelled.signer.signDelegateAction(creation(cancelled))).rejects.toThrow(SigningCancelledError);
    const unprotected = userWallet(true, false);
    await expect(unprotected.signer.signDelegateAction(creation(unprotected))).rejects.toThrow("protect your account");
    expect(cancelled.signed).toHaveLength(0);
    expect(unprotected.signed).toHaveLength(0);
    expect(unprotected.shown).toHaveLength(0);
  });

  const call = (method: string, args: object, deposit = COST) => actions.functionCall(method, args, 10n ** 14n, deposit);
  const refusedCreations: [string, (w: Wallet) => ReturnType<typeof creation>][] = [
    ["a request to another contract", (w) => creation(w, "stranger.near")],
    ["another method on the rules contract", (w) => creation(w, "outlayer.near", [call("freeze_wallet", rules)])],
    ["rules that would be locked", (w) => creation(w, "outlayer.near", [call("store_wallet_policy", { ...rules, locked: true })])],
    ["an unexpected argument", (w) => creation(w, "outlayer.near", [call("store_wallet_policy", { ...rules, controller: "stranger.near" })])],
    ["a cost above the expected one", (w) => creation(w, "outlayer.near", [call("store_wallet_policy", rules, 10n ** 24n)])],
    ["an agent key that is not an ed25519 key", (w) => creation(w, "outlayer.near", [call("store_wallet_policy", { ...rules, wallet_pubkey: "agent.near" })])],
    ["a second action next to the creation", (w) => creation(w, "outlayer.near", [call("store_wallet_policy", rules), actions.transfer(1n)])],
    ["a plain transfer", (w) => creation(w, "outlayer.near", [actions.transfer(1n)])],
  ];

  it.each(refusedCreations)("refuses %s before asking the user or the wallet", async (_name, build) => {
    const wallet = userWallet();
    await expect(wallet.signer.signDelegateAction(build(wallet))).rejects.toThrow(RefusedSigningError);
    expect(wallet.shown).toHaveLength(0);
    expect(wallet.signed).toHaveLength(0);
  });

  // The two calls the Agent API sends to freeze an agent: its rules stored again marked frozen, then the freeze.
  const frozenRules = Object.fromEntries(Object.entries(rules).filter(([k]) => k !== "storage_refund_to"));
  const freezeCalls = (store: object = frozenRules, target: object = { wallet_pubkey: rules.wallet_pubkey }, deposit = 0n): Action[] => [
    actions.functionCall("store_wallet_policy", store, 5n * 10n ** 13n, deposit),
    actions.functionCall("freeze_wallet", target, 5n * 10n ** 13n, 0n),
  ];

  it("shows a freeze of the user's own agent in plain words and signs after the user confirms", async () => {
    const wallet = userWallet();
    const { signedDelegate } = await wallet.signer.signDelegateAction(creation(wallet, "outlayer.near", freezeCalls()));
    expect(wallet.shown).toEqual([[`Freeze your agent (${AGENT}): it can do nothing until you unfreeze it.`, "Its money stays with it. Nothing is sent anywhere."]]);
    expect(agentFreezeOf(signedDelegate.delegateAction, config)).toEqual({ agentAccount: AGENT, frozen: true });
  });

  it("shows an unfreeze of the user's own agent in plain words, and tells it apart from a freeze", async () => {
    const wallet = userWallet();
    const unfreeze = [freezeCalls()[0] as Action, actions.functionCall("unfreeze_wallet", { wallet_pubkey: rules.wallet_pubkey }, 5n * 10n ** 13n, 0n)];
    const { signedDelegate } = await wallet.signer.signDelegateAction(creation(wallet, "outlayer.near", unfreeze));
    expect(wallet.shown).toEqual([[`Unfreeze your agent (${AGENT}): Inti can trade for you again, within your rules.`]]);
    expect(agentFreezeOf(signedDelegate.delegateAction, config)).toEqual({ agentAccount: AGENT, frozen: false });
  });

  const refusedFreezes: [string, (w: Wallet) => ReturnType<typeof creation>][] = [
    ["a freeze sent to another contract", (w) => creation(w, "stranger.near", freezeCalls())],
    ["a freeze of another agent than the rules name", (w) => creation(w, "outlayer.near", freezeCalls(frozenRules, { wallet_pubkey: `ed25519:${"81".repeat(32)}` }))],
    ["a freeze that costs something", (w) => creation(w, "outlayer.near", freezeCalls(frozenRules, { wallet_pubkey: rules.wallet_pubkey }, 1n))],
    ["a freeze whose rules would be locked", (w) => creation(w, "outlayer.near", freezeCalls({ ...frozenRules, locked: true }))],
    ["a freeze with an extra argument", (w) => creation(w, "outlayer.near", freezeCalls(frozenRules, { wallet_pubkey: rules.wallet_pubkey, to: "stranger.near" }))],
    ["two calls that are not a freeze", (w) => creation(w, "outlayer.near", [call("store_wallet_policy", frozenRules, 0n), call("unlock_wallet", { wallet_pubkey: rules.wallet_pubkey }, 0n)])],
    ["a freeze in the wrong order", (w) => creation(w, "outlayer.near", [...freezeCalls()].reverse())],
  ];

  it.each(refusedFreezes)("refuses %s before asking the user or the wallet", async (_name, build) => {
    const wallet = userWallet();
    await expect(wallet.signer.signDelegateAction(build(wallet))).rejects.toThrow(RefusedSigningError);
    expect(wallet.shown).toHaveLength(0);
    expect(wallet.signed).toHaveLength(0);
  });

  it("installs Spending Limits only for the user's own agent", async () => {
    const wallet = userWallet();
    const withoutAgent = new LimitsClient({ ...config, agentAccount: null });
    await expect(withoutAgent.activate(wallet.accountId, wallet.signer, expectedWasm, { perOrder: 1n, perDay: 2n }, 1n, PRICES)).rejects.toThrow("Create your agent first");
    expect(wallet.signed).toHaveLength(0);
  });
});

describe("turning Inti off", () => {
  const WRAPPED = 10n ** 23n;

  it("shows both transactions in one confirmation, then signs both without asking again", async () => {
    const wallet = userWallet();
    const client = clientSigningThrough(wallet);
    const plan = client.releasePlan(wallet.accountId, WRAPPED, true);
    await wallet.signer.approveAll(plan);
    await client.send(wallet.accountId, wallet.signer, plan);

    expect(wallet.shown).toEqual([
      [
        "Move 0.1 NEAR from Inti's trading balance back to your main balance.",
        "Turn off Inti's access to your account.",
        "Remove Inti's setup from your account. The NEAR set aside for it goes back to your main balance.",
      ],
    ]);
    expect(wallet.signed).toHaveLength(2);
  });

  it("leaves out the steps that are not needed", () => {
    const client = new LimitsClient(config);
    const plan = client.releasePlan("ab".repeat(32), 0n, false);
    expect(plan).toHaveLength(1);
    expect(plan[0]?.actions).toHaveLength(1);
  });

  it("asks again for any transaction that is not the approved one", async () => {
    const wallet = userWallet();
    const client = clientSigningThrough(wallet);
    await wallet.signer.approveAll(client.releasePlan(wallet.accountId, WRAPPED, true));
    await client.setLimit(wallet.accountId, wallet.signer, { perOrder: 1n, perDay: 2n }, PRICES);
    expect(wallet.shown).toHaveLength(2);
    expect(wallet.shown[1]?.[0]).toBe("Set your limit: at most 0.000000000000000000000001 NEAR per order and 0.000000000000000000000002 NEAR per day.");
  });

  it("signs nothing when the user cancels the confirmation", async () => {
    const wallet = userWallet(false);
    const client = clientSigningThrough(wallet);
    await expect(wallet.signer.approveAll(client.releasePlan(wallet.accountId, WRAPPED, true))).rejects.toThrow(SigningCancelledError);
    expect(wallet.signed).toHaveLength(0);
  });

  const refusedReleases: [string, (w: Wallet) => [string, Action[]]][] = [
    ["unwrapping with no yoctoNEAR attached", () => [config.token.id, [actions.functionCall("near_withdraw", { amount: "1" }, 1n, 0n)]]],
    ["unwrapping with an extra argument", () => [config.token.id, [actions.functionCall("near_withdraw", { amount: "1", receiver_id: "stranger.near" }, 1n, 1n)]]],
    ["unwrapping nothing", () => [config.token.id, [actions.functionCall("near_withdraw", { amount: "0" }, 1n, 1n)]]],
    ["installing any other contract", (w) => [w.accountId, [actions.deployContract(new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x00]))]]],
  ];

  it.each(refusedReleases)("refuses %s before asking the user or the wallet", async (_name, build) => {
    const wallet = userWallet();
    const [receiverId, txActions] = build(wallet);
    await expect(sign(wallet, receiverId, txActions)).rejects.toThrow(RefusedSigningError);
    expect(wallet.shown).toHaveLength(0);
    expect(wallet.signed).toHaveLength(0);
  });

  it("the empty contract is the 8-byte wasm header and nothing else", () => {
    expect(Array.from(EMPTY_CONTRACT)).toEqual([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
  });
});

describe("how much NEAR activation asks for", () => {
  it("covers creating the agent until the user has one, so the last step is never left short", () => {
    const withAgent = LimitsClient.activationNeeds(expectedWasm.length, 10n ** 23n);
    const beforeAgent = LimitsClient.activationNeeds(expectedWasm.length, 10n ** 23n, true);
    const agentCost = 14_510_000_000_000_000_000_000n;
    expect(beforeAgent - agentCost).toBeGreaterThanOrEqual(withAgent);
  });
});

describe("adding NEAR for orders after activation", () => {
  it("wraps the amount in one transaction to the token, shown in plain words before signing", async () => {
    const wallet = userWallet();
    const client = clientSigningThrough(wallet);
    await client.addForOrders(wallet.accountId, wallet.signer, 3n * 10n ** 23n);

    expect(wallet.signed).toHaveLength(1);
    expect(wallet.shown).toEqual([["Turn 0.3 NEAR into NEAR your agent can be funded from. It stays in your account."]]);
  });

  it("signs nothing when the user cancels", async () => {
    const wallet = userWallet(false);
    const client = clientSigningThrough(wallet);
    await expect(client.addForOrders(wallet.accountId, wallet.signer, 10n ** 23n)).rejects.toThrow(SigningCancelledError);
    expect(wallet.signed).toHaveLength(0);
  });

  it("leaves 0.05 NEAR free for network fees, and nothing to add below that", () => {
    expect(LimitsClient.maxForOrders(10n ** 24n)).toBe(95n * 10n ** 22n);
    expect(LimitsClient.maxForOrders(5n * 10n ** 22n)).toBe(0n);
    expect(LimitsClient.maxForOrders(0n)).toBe(0n);
  });
});

describe("the contract code the app installs", () => {
  it("the pinned hash is the hash of the shipped build", () => {
    expect(wasmSha256(expectedWasm)).toBe(SPENDING_LIMITS_WASM_SHA256);
  });

  it("loads the expected build", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(expectedWasm, { status: 200 }))));
    await expect(new LimitsClient(config).loadWasm()).resolves.toEqual(expectedWasm);
  });

  it("refuses any other code the site serves", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(new TextEncoder().encode("any other contract"), { status: 200 }))));
    await expect(new LimitsClient(config).loadWasm()).rejects.toThrow("does not match the expected build");
  });
});
