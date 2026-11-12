/**
 * The assets Inti's agent may buy, by a fixed key the model chooses from. Asset ids are the NEAR
 * Intents ids listed by GET /v1/tokens; the model never writes an id or an address.
 */
export const ASSETS = {
  gold: { name: "Gold", symbol: "XAUT", assetId: "nep141:eth-0x68749665ff8d2d112fa859aa293f07a622782f38.omft.near", kind: "real-world" },
  // The euro is tokenized money, redeemable one to one: a currency, not an asset like gold.
  euro: { name: "Euro", symbol: "EURe", assetId: "nep141:gnosis-0x420ca0f9b9b604ce0fd9c18ef134c705e5fa3430.omft.near", kind: "currency" },
  bitcoin: { name: "Bitcoin", symbol: "BTC", assetId: "nep141:btc.omft.near", kind: "crypto" },
  ethereum: { name: "Ether", symbol: "ETH", assetId: "nep141:eth.omft.near", kind: "crypto" },
  solana: { name: "Solana", symbol: "SOL", assetId: "nep141:sol.omft.near", kind: "crypto" },
} as const;

export type AssetKey = keyof typeof ASSETS;
export const ASSET_KEYS = Object.keys(ASSETS) as [AssetKey, ...AssetKey[]];
