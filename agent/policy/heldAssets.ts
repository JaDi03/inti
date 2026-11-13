import { ASSETS, type AssetKey } from "./assets.js";

/**
 * Assets that stay on the owner's agent, in its confidential NEAR Intents balance, instead of
 * reaching the owner's wallet. The Agent API sends from a confidential balance only to NEAR tokens,
 * and these live on other chains (gold and the euro on Ethereum and Gnosis, SOL on Solana), so
 * the agent holds them. Selling one turns it into NEAR, which goes to the owner's wallet. Ids and
 * decimals are those listed by GET /v1/tokens.
 */
export const HELD_ASSETS = {
  gold: { name: "Gold", symbol: "XAUT", assetId: "nep141:eth-0x68749665ff8d2d112fa859aa293f07a622782f38.omft.near", decimals: 6, kind: "real-world" },
  // The euro is tokenized money, redeemable one to one: a currency, not an asset like gold.
  euro: { name: "Euro", symbol: "EURe", assetId: "nep141:gnosis-0x420ca0f9b9b604ce0fd9c18ef134c705e5fa3430.omft.near", decimals: 18, kind: "currency" },
  solana: { name: "Solana", symbol: "SOL", assetId: "nep141:sol.omft.near", decimals: 9, kind: "crypto" },
} as const;

export type HeldKey = keyof typeof HELD_ASSETS;
export const HELD_KEYS = Object.keys(HELD_ASSETS) as [HeldKey, ...HeldKey[]];
const HELD_IDS: ReadonlySet<string> = new Set(HELD_KEYS.map((k) => HELD_ASSETS[k].assetId));

/** Whether `assetId` is one the agent keeps instead of sending to the wallet. */
export function isHeld(assetId: string): boolean {
  return HELD_IDS.has(assetId);
}

/** Every asset Inti trades: the ones that reach the wallet and the ones the agent keeps. */
export type TradableKey = AssetKey | HeldKey;
export const TRADABLE_KEYS = [...(Object.keys(ASSETS) as AssetKey[]), ...HELD_KEYS] as [TradableKey, ...TradableKey[]];

export function tradable(key: TradableKey): { name: string; symbol: string; assetId: string; decimals: number; held: boolean } {
  const a = key in HELD_ASSETS ? HELD_ASSETS[key as HeldKey] : ASSETS[key as AssetKey];
  return { name: a.name, symbol: a.symbol, assetId: a.assetId, decimals: a.decimals, held: isHeld(a.assetId) };
}
