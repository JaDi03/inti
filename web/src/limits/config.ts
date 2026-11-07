/**
 * Per-network settings for Spending Limits. Values that differ per environment come from
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

export interface LimitsConfig {
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

/** The network the app opens on when the user has not picked one (INTI_NETWORK, else testnet). */
export function defaultNetwork(): NetworkId {
  return env.INTI_NETWORK === "mainnet" ? "mainnet" : "testnet";
}

/** Thrown for a network the app cannot use yet; the UI shows it as "coming soon". */
export class NetworkNotReadyError extends Error {}

export function loadLimitsConfig(networkId: NetworkId): LimitsConfig {
  if (networkId === "mainnet") {
    // Mainnet needs the real agent from the Agent API and a verified USDC token id.
    throw new NetworkNotReadyError("Mainnet is coming soon.");
  }
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
    wasmUrl: "/inti-spending-limits.wasm",
  };
}
