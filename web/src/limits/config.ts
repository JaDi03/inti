/**
 * Settings for Spending Limits on NEAR mainnet. Values that differ per environment come from
 * the root .env (INTI_* variables ship to the browser, so they must be public).
 */
export interface TokenConfig {
  /** NEP-141 contract id. */
  id: string;
  /** What the user sees (wrapped NEAR is shown as NEAR). */
  symbol: string;
  decimals: number;
}

export interface LimitsConfig {
  rpcUrl: string;
  explorerTxUrl: (hash: string) => string;
  /** The NEAR Intents verifier contract. */
  intentsAccount: string;
  /** The user's own agent account that orders are sent to, or null until the user has created it. */
  agentAccount: string | null;
  /** The contract that stores each agent's rules; creating an agent is one call to it. */
  agentRulesContract: string;
  token: TokenConfig;
  /** Public key of Inti's function-call key (the private key never reaches the browser). */
  intiPublicKey: string;
  /** Allowance for Inti's key: it only pays gas, and cannot be raised later. */
  intiKeyAllowanceYocto: bigint;
  wasmUrl: string;
  /** sha256 (hex) of the contract build the app may install; any other code is never deployed. */
  wasmSha256: string;
  /** Host of the NEAR Intents Agent API: the only service a grant may be signed for. */
  agentApiHost: string;
}

/**
 * sha256 of web/public/inti-spending-limits.wasm, the only build the app installs. Rebuild it
 * with `cargo near build reproducible-wasm` in contracts/spending-limits to get the same hash.
 */
export const SPENDING_LIMITS_WASM_SHA256 = "ec08c308af218f6d1273a1ae785617d67b9bb3fa3ed95f843a5e1a9c19c3d161";

const env = import.meta.env as Record<string, string | undefined>;

function required(name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is missing from the root .env file.`);
  return value;
}

const NEAR = 10n ** 24n;

export function loadLimitsConfig(agentAccount: string | null): LimitsConfig {
  return {
    // FastNEAR's public endpoint, listed in docs.near.org/api/rpc/providers (free tier, limit not published).
    rpcUrl: "https://free.rpc.fastnear.com",
    explorerTxUrl: (hash) => `https://nearblocks.io/txns/${hash}`,
    intentsAccount: "intents.near",
    agentAccount,
    agentRulesContract: "outlayer.near",
    // Wrapped NEAR, shown to the user as NEAR.
    token: { id: "wrap.near", symbol: "NEAR", decimals: 24 },
    intiPublicKey: required("INTI_KEY_PUBLIC"),
    intiKeyAllowanceYocto: NEAR / 4n,
    wasmUrl: "/inti-spending-limits.wasm",
    wasmSha256: SPENDING_LIMITS_WASM_SHA256,
    agentApiHost: required("INTI_AGENT_API_HOST"),
  };
}
