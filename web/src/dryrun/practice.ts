import { ASSET_KEYS, type AssetKey } from "../../../agent/policy/assets";
import { LimitsClient, type LimitsStatus, type SpendLimit } from "../limits/client";
import { loadLimitsConfig, type LimitsConfig } from "../limits/config";

/** What a dry-run button that would sign says instead. */
export const NOTHING_SIGNED = "In the dry run nothing is signed. Open the app to do this with your own wallet.";

/** The practice wallet: a well-formed address nobody holds a key for, so nothing can ever be signed for it. */
export const PRACTICE_WALLET = "0".repeat(64);
/** The practice agent's name on the page. */
export const PRACTICE_AGENT = "practice-agent";

/** The practice money and limits, the same kind the owner signs in Spending Limits. */
export const PRACTICE_USD = 100;
const PER_ORDER_USD = 25;
const PER_DAY_USD = 50;
/** Plain NEAR the practice wallet keeps for network fees. */
const PLAIN_NEAR = 10n ** 24n / 2n;
/** Size of the Spending Limits build the app installs; the network keeps NEAR aside for it. */
const SPENDING_LIMITS_WASM_BYTES = 165_756;

const NEAR = 10n ** 24n;

/** Dollars to atomic NEAR at a price, without floats past the cents. */
function nearFor(usd: number, nearPrice: number): bigint {
  return (BigInt(Math.round(usd * 100)) * NEAR * 1_000_000n) / (100n * BigInt(Math.round(nearPrice * 1_000_000)));
}

/** The app's own settings, with the practice agent in place of the user's. */
export function practiceConfig(): LimitsConfig {
  return loadLimitsConfig(PRACTICE_AGENT);
}

/** An installed Spending Limits account holding $100 in NEAR for orders, at the given NEAR price. */
export function practiceStatus(nearPrice: number): Extract<LimitsStatus, { kind: "installed" }> {
  const limit: SpendLimit = { perOrder: nearFor(PER_ORDER_USD, nearPrice), perDay: nearFor(PER_DAY_USD, nearPrice) };
  return {
    kind: "installed",
    available: PLAIN_NEAR,
    intiConnected: true,
    intiFeesLeft: NEAR / 4n,
    agent: PRACTICE_AGENT,
    limit,
    sellsAllowed: true,
    spentToday: 0n,
    spendable: nearFor(PRACTICE_USD, nearPrice),
    setAside: LimitsClient.storageCost(SPENDING_LIMITS_WASM_BYTES),
  };
}

/**
 * The real client with every action that would sign replaced by a refusal: the dry run reads its
 * practice numbers and never reaches the network to change anything.
 */
export class PracticeLimitsClient extends LimitsClient {
  override status(): Promise<LimitsStatus> {
    return Promise.reject(new Error(NOTHING_SIGNED));
  }
  override assets(): Promise<{ key: AssetKey; enabled: boolean; balance: bigint }[]> {
    return Promise.resolve(ASSET_KEYS.map((key) => ({ key, enabled: true, balance: 0n })));
  }
  override enableAsset(): Promise<string> {
    return Promise.reject(new Error(NOTHING_SIGNED));
  }
  override activate(): Promise<string[]> {
    return Promise.reject(new Error(NOTHING_SIGNED));
  }
  override addForOrders(): Promise<string> {
    return Promise.reject(new Error(NOTHING_SIGNED));
  }
  override moveToWallet(): Promise<string> {
    return Promise.reject(new Error(NOTHING_SIGNED));
  }
  override send(): Promise<string[]> {
    return Promise.reject(new Error(NOTHING_SIGNED));
  }
  override setLimit(): Promise<string> {
    return Promise.reject(new Error(NOTHING_SIGNED));
  }
  override disconnectInti(): Promise<string> {
    return Promise.reject(new Error(NOTHING_SIGNED));
  }
  override reconnectInti(): Promise<string> {
    return Promise.reject(new Error(NOTHING_SIGNED));
  }
}
