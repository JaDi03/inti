/**
 * The assets Inti's agent may buy and sell, by a fixed key the model chooses from. Asset ids are the
 * NEAR Intents ids listed by GET /v1/tokens; decimals are each token's `ft_metadata`. The model never
 * writes an id or an address.
 */
// Only assets the Agent API can send from the agent's confidential balance to a NEAR wallet: the
// ones 1Click lists on the near chain. Each is a NEAR token the wallet registers with once
// (storage_deposit), which every one of these lets any account do.
export const ASSETS = {
  bitcoin: { name: "Bitcoin", symbol: "BTC", assetId: "nep141:nbtc.bridge.near", decimals: 8, kind: "crypto" },
  ethereum: { name: "Ether", symbol: "ETH", assetId: "nep141:eth.bridge.near", decimals: 18, kind: "crypto" },
  // Zcash keeps its own transfers private: it fits an agent that trades from a confidential balance.
  zcash: { name: "Zcash", symbol: "ZEC", assetId: "nep141:zec.omft.near", decimals: 8, kind: "crypto" },
  // Staked NEAR from Meta Pool: its value in NEAR grows with staking rewards.
  stnear: { name: "Staked NEAR", symbol: "stNEAR", assetId: "nep141:meta-pool.near", decimals: 24, kind: "staking" },
} as const;

export type AssetKey = keyof typeof ASSETS;
export const ASSET_KEYS = Object.keys(ASSETS) as [AssetKey, ...AssetKey[]];
