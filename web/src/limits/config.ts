/**
 * Per-network settings for the vault. Values that differ per environment come from
 * the root .env (INTI_* variables ship to the browser, so they must be public).
 */
export type NetworkId = "testnet" | "mainnet";

export interface TokenConfig {
  /** NEP-141 contract id. */
  id: string;
  /** What the user sees (wrapped NEAR is shown as NEAR). */
  symbol: string;
  decimals: number;
}

export interface VaultConfig {
  networkId: NetworkId;
  rpcUrl: string;
  explorerTxUrl: (hash: string) => string;
  /** NEAR Intents verifier; on testnet a stand-in account (Intents has no testnet). */
  intentsAccount: string;
  /** The user's agent account. Until the Agent API is wired, a stand-in from .env. */
  agentAccount: string;
  token: TokenConfig;
  /** Public key of Inti's function-call key (the private key never reaches the browser). */
  intiPublicKey: string;
  /** Allowance for Inti's key: it only pays gas, and cannot be raised later. */
  intiKeyAllowanceYocto: bigint;
  wasmUrl: string;
}

const env = import.meta.env as Record<string, string | undefined>;

function required(name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is missing from the root .env file.`);
  return value;
}

const NEAR = 10n ** 24n;

export function loadVaultConfig(): VaultConfig {
  const networkId = (env.INTI_NETWORK ?? "testnet") as NetworkId;
  if (networkId === "mainnet") {
    // Mainnet needs the real agent from the Agent API and a verified USDC token id.
    throw new Error("The vault is not configured for mainnet yet.");
  }
  if (networkId !== "testnet") throw new Error(`Unknown INTI_NETWORK: ${String(networkId)}`);
  const standIn = required("INTI_TESTNET_AGENT_ACCOUNT");
  return {
    networkId,
    // FastNEAR, listed in docs.near.org/api/rpc/providers. rpc.testnet.near.org is
    // deprecated and capped at 30 requests per minute (near.org RPC deprecation notice).
    rpcUrl: "https://test.rpc.fastnear.com",
    explorerTxUrl: (hash) => `https://testnet.nearblocks.io/txns/${hash}`,
    intentsAccount: standIn,
    agentAccount: standIn,
    token: { id: "wrap.testnet", symbol: "NEAR", decimals: 24 },
    intiPublicKey: required("INTI_KEY_PUBLIC"),
    intiKeyAllowanceYocto: NEAR / 4n,
    wasmUrl: "/inti-vault.wasm",
  };
}
