import { Account, KeyPair } from "near-api-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LimitsClient } from "./client";
import { SPENDING_LIMITS_WASM_SHA256, type LimitsConfig } from "./config";
import { assetContract } from "./ownerActions";

const config: LimitsConfig = {
  rpcUrl: "http://127.0.0.1:1",
  explorerTxUrl: (hash) => hash,
  intentsAccount: "intents.near",
  agentAccount: "cd".repeat(32),
  agentRulesContract: "outlayer.near",
  token: { id: "wrap.near", symbol: "NEAR", decimals: 24 },
  intiPublicKey: KeyPair.fromRandom("ed25519").getPublicKey().toString(),
  intiKeyAllowanceYocto: 25n * 10n ** 22n,
  wasmUrl: "/inti-spending-limits.wasm",
  wasmSha256: SPENDING_LIMITS_WASM_SHA256,
  agentApiHost: "api.demo.agentsonintents.com",
};

/** An installed account whose Inti key answers as given; `null` means the account has no such key. */
function installed(permission: unknown, limits: string[] = []) {
  vi.spyOn(Account.prototype, "getState").mockResolvedValue({ balance: { available: 1n, usedOnStorage: 2n }, codeHash: "x" } as never);
  vi.spyOn(Account.prototype, "getAccessKey").mockImplementation(() => (permission === null ? Promise.reject(new Error("no key")) : Promise.resolve({ nonce: 1, permission } as never)));
  const client = new LimitsClient(config);
  vi.spyOn(client.provider, "callFunction").mockImplementation(({ method, args }) => {
    const token = (args as { token?: string }).token ?? "";
    const limit = limits.includes(token) ? { per_order: "1", per_day: "2" } : null;
    return Promise.resolve((method === "get_config" ? { agent: config.agentAccount } : method === "get_limit" ? limit : "0") as never);
  });
  return client;
}

describe("whether the saved limits cover selling", () => {
  it("is false for an account set up before selling, and true once its limits were saved again", async () => {
    expect(await installed(null, ["wrap.near"]).status("ab".repeat(32))).toMatchObject({ sellsAllowed: false, limit: { perOrder: 1n, perDay: 2n } });
    vi.restoreAllMocks();
    expect(await installed(null, ["wrap.near", assetContract("gold")]).status("ab".repeat(32))).toMatchObject({ sellsAllowed: true });
  });
});

afterEach(() => vi.restoreAllMocks());

describe("what Inti's key may still spend on fees", () => {
  it("reads the allowance left on the key, as one total", async () => {
    // Shape of a live view_access_key answer for Inti's key.
    const status = await installed({ FunctionCall: { allowance: "247592500473979900000000", method_names: ["fund_agent"], receiver_id: "ab".repeat(32) } }).status("ab".repeat(32));
    expect(status).toMatchObject({ kind: "installed", intiConnected: true, intiFeesLeft: 247592500473979900000000n, agent: config.agentAccount });
  });

  it("shows no amount for a key without a fee cap, and none when Inti is off", async () => {
    expect(await installed({ FunctionCall: { allowance: null, method_names: ["fund_agent"], receiver_id: "x" } }).status("ab".repeat(32))).toMatchObject({ intiConnected: true, intiFeesLeft: null });
    expect(await installed(null).status("ab".repeat(32))).toMatchObject({ intiConnected: false, intiFeesLeft: null });
  });
});
