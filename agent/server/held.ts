import { isHeld } from "../policy/heldAssets.js";
import { FUNDING_ASSET, FUNDING_TOKEN, fund, swapOnAgent, type AgentPort, type ChainPort, type OrderAccount, type OrderRefusal } from "./orders.js";

/**
 * Buying and selling the assets the agent keeps for its owner (gold, the euro, SOL). A purchase is
 * paid with the owner's NEAR like any other, but what it buys stays in the agent's confidential
 * balance. A sale turns what the agent holds into NEAR and sends the NEAR to the owner's wallet.
 */

export type HeldBuyResult =
  | { status: "done"; spent: bigint; received: bigint; asset: string }
  | { status: "refused"; code: OrderRefusal | "unknown_asset" }
  | { status: "returned"; code: "no_route" | "swap_failed" | "shield_failed" }
  | { status: "pending" };

export type HeldSellResult =
  | { status: "done"; sold: bigint; received: bigint }
  /** Nothing moved: the asset is still with the agent. */
  | { status: "refused"; code: "unknown_asset" | "not_enough" | "no_quote" }
  /** The trade did not happen; the asset is still with the agent. */
  | { status: "kept"; code: "swap_failed" }
  | { status: "pending" };

/**
 * Funds the agent with exactly `amount` of NEAR within the owner's limits and buys `asset` with it.
 * The result stays on the agent. If the trade cannot happen, the NEAR goes back to the wallet.
 */
export async function buyHeld(chain: ChainPort, agent: AgentPort, account: OrderAccount, asset: string, amount: bigint, wait = sleep): Promise<HeldBuyResult> {
  if (!isHeld(asset)) return { status: "refused", code: "unknown_asset" };
  const bound = await agent.signedPriceBound(account.agentId);
  // Quoted before any money moves, so an order with no route sends nothing at all.
  if ((await agent.quote(account.agentId, FUNDING_ASSET, asset, amount)) === null) return { status: "refused", code: "no_quote" };
  const funded = await fund(chain, agent, account, FUNDING_TOKEN, amount, wait);
  if (funded === "pending") return { status: "pending" };
  if (funded === "returned") return { status: "returned", code: "shield_failed" };
  if (funded !== "funded") return { status: "refused", code: funded };

  const received = await swapOnAgent(agent, account, FUNDING_ASSET, asset, amount, bound);
  if (received === "pending") return { status: "pending" };
  if (typeof received !== "bigint") {
    // Says "returned" only once the NEAR is back; a slow return is left to the sweep, which sends NEAR home.
    const code = received === "no_route" ? "no_route" : "swap_failed";
    return (await agent.withdraw(account, FUNDING_ASSET, amount)) === "success" ? { status: "returned", code } : { status: "pending" };
  }
  return { status: "done", spent: amount, received, asset };
}

/**
 * Sells `amount` of `asset` from what the agent holds for NEAR, within the owner's price
 * protection, and sends the NEAR to the owner's wallet. NEAR the agent could not send yet is left
 * to the sweep, which sends it home.
 */
export async function sellHeld(agent: AgentPort, account: OrderAccount, asset: string, amount: bigint): Promise<HeldSellResult> {
  if (!isHeld(asset)) return { status: "refused", code: "unknown_asset" };
  if (amount <= 0n || ((await agent.available(account.agentId)).get(asset) ?? 0n) < amount) return { status: "refused", code: "not_enough" };
  const bound = await agent.signedPriceBound(account.agentId);
  const near = await swapOnAgent(agent, account, asset, FUNDING_ASSET, amount, bound);
  if (near === "no_route") return { status: "refused", code: "no_quote" };
  if (near === "failed") return { status: "kept", code: "swap_failed" };
  if (near === "pending") return { status: "pending" };
  return (await agent.withdraw(account, FUNDING_ASSET, near)) === "success" ? { status: "done", sold: amount, received: near } : { status: "pending" };
}

/** What the agent keeps for its owner: atomic amounts of each held asset it has. */
export async function heldBalances(agent: AgentPort, agentId: string): Promise<Map<string, bigint>> {
  const all = await agent.available(agentId);
  return new Map([...all].filter(([id, amount]) => isHeld(id) && amount > 0n));
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
