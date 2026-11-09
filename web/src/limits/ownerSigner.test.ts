import { readFileSync } from "node:fs";
import { Account, actions, createTransaction, KeyPair } from "near-api-js";
import type { Action, KeyPairEd25519 } from "near-api-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrivyNearSigner, type SignRawHash } from "../privySigner";
import { LimitsClient } from "./client";
import { SPENDING_LIMITS_WASM_SHA256, type LimitsConfig } from "./config";
import { RefusedSigningError, wasmSha256 } from "./ownerActions";
import { OwnerSigner, SigningCancelledError } from "./ownerSigner";

const expectedWasm = new Uint8Array(readFileSync(new URL("../../public/inti-spending-limits.wasm", import.meta.url)));
const intiKey = KeyPair.fromRandom("ed25519").getPublicKey();

const config: LimitsConfig = {
  networkId: "testnet",
  rpcUrl: "http://127.0.0.1:1",
  explorerTxUrl: (hash) => hash,
  intentsAccount: "intents.testnet",
  agentAccount: "agent.testnet",
  token: { id: "wrap.testnet", symbol: "NEAR", decimals: 24 },
  intiPublicKey: intiKey.toString(),
  intiKeyAllowanceYocto: 10n ** 23n,
  wasmUrl: "/inti-spending-limits.wasm",
  wasmSha256: SPENDING_LIMITS_WASM_SHA256,
};

/** A user wallet whose key really signs, plus a record of every hash it was asked to sign. */
function userWallet(answer = true) {
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
  const signer = new OwnerSigner(new PrivyNearSigner(accountId, signRawHash), config, confirm);
  return { publicKey, accountId, signed, shown, signer };
}

type Wallet = ReturnType<typeof userWallet>;

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
    await client.activate(wallet.accountId, wallet.signer, expectedWasm, { perOrder: 10n ** 24n, perDay: 3n * 10n ** 24n }, 10n ** 23n);

    expect(wallet.signed).toHaveLength(2);
    expect(wallet.shown).toHaveLength(2);
    expect(wallet.shown[0]).toEqual([
      `Install the Spending Limits contract on your account (expected build ${SPENDING_LIMITS_WASM_SHA256.slice(0, 12)}).`,
      "Set up Spending Limits so orders can only go to your agent (agent.testnet).",
      "Set your limit: at most 1 NEAR per order and 3 NEAR per day.",
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
    await client.setLimit(wallet.accountId, wallet.signer, { perOrder: 5n * 10n ** 23n, perDay: 10n ** 24n });
    await client.disconnectInti(wallet.accountId, wallet.signer);
    await client.reconnectInti(wallet.accountId, wallet.signer);

    expect(wallet.signed).toHaveLength(3);
    expect(wallet.shown).toEqual([
      ["Set your limit: at most 0.5 NEAR per order and 1 NEAR per day."],
      ["Remove Inti's key from your account. Inti can no longer fund your agent."],
      [
        "Give Inti a key that can only call fund_agent: it can send to your agent only within the spending limits you set.",
        "That key can also use up to 0.1 NEAR of your balance to pay network fees. This is not a spending limit.",
      ],
    ]);
  });

  it("nothing is signed when the user cancels", async () => {
    const wallet = userWallet(false);
    const client = clientSigningThrough(wallet);
    await expect(client.setLimit(wallet.accountId, wallet.signer, { perOrder: 1n, perDay: 2n })).rejects.toThrow(SigningCancelledError);
    expect(wallet.shown).toHaveLength(1);
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

  it("never signs messages or delegate actions", async () => {
    const wallet = userWallet();
    await expect(wallet.signer.signNep413Message()).rejects.toThrow(RefusedSigningError);
    expect(() => wallet.signer.signDelegateAction()).toThrow(RefusedSigningError);
    expect(wallet.signed).toHaveLength(0);
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
