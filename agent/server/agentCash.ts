import { FUNDING_ASSET, staysOnAgent, swapOnAgent, tokenContract, type AgentPort, type ChainPort, type OrderAccount } from "./orders.js";

/**
 * Trades made with what the owner's agent already holds: its NEAR (from earlier sales) and the
 * assets it keeps (gold, the euro, SOL). Nothing comes from the owner's wallet, so a request like
 * "sell my gold and buy bitcoin" runs inside the agent. NEAR and kept assets stay on the agent;
 * an asset bought for the wallet is sent to the wallet.
 */

export type InsideResult =
  | { status: "done"; spent: bigint; received: bigint; asset: string; kept: boolean }
  /** Nothing moved. */
  | { status: "refused"; code: "same_asset" | "asset_not_enabled" | "orders_open" | "not_enough" | "no_quote" }
  /** The trade did not finish; what was sold stays with the agent, as itself or, after half the route, as NEAR. */
  | { status: "kept"; code: "swap_failed" | "half_done" }
  /** The wallet cannot receive this asset from the agent, so its value stayed with the agent as NEAR. */
  | { status: "returned"; code: "not_deliverable"; kept: true }
  | { status: "pending" };

export type CashHomeResult = { status: "done"; sent: bigint } | { status: "refused"; code: "orders_open" | "not_enough" } | { status: "failed" } | { status: "pending" };

/** NEAR the agent holds that is free to spend: none while a limit order may still be resting on it. */
export async function freeCash(agent: AgentPort, agentId: string): Promise<bigint> {
  if ((await agent.openLimitOrders(agentId)) > 0) return 0n;
  return (await agent.available(agentId)).get(FUNDING_ASSET) ?? 0n;
}

/**
 * Swaps `amount` of `from`, which the agent holds, into `to`, directly or through NEAR, never below
 * the owner's signed price protection. A result for the wallet is sent there; a slow delivery is
 * left to the sweep, which sends wallet assets home.
 */
export async function tradeOnAgent(chain: ChainPort, agent: AgentPort, account: OrderAccount, from: string, to: string, amount: bigint): Promise<InsideResult> {
  if (from === to) return { status: "refused", code: "same_asset" };
  if (!staysOnAgent(to)) {
    const contract = tokenContract(to);
    if (!contract || !(await chain.registered(contract, account.owner))) return { status: "refused", code: "asset_not_enabled" };
  }
  // NEAR resting for a limit order is not free to spend.
  if (from === FUNDING_ASSET && (await agent.openLimitOrders(account.agentId)) > 0) return { status: "refused", code: "orders_open" };
  if (amount <= 0n || ((await agent.available(account.agentId)).get(from) ?? 0n) < amount) return { status: "refused", code: "not_enough" };
  const bound = await agent.signedPriceBound(account.agentId);

  let received = await swapOnAgent(agent, account, from, to, amount, bound);
  if (received === "no_route" && from !== FUNDING_ASSET && to !== FUNDING_ASSET) {
    const near = await swapOnAgent(agent, account, from, FUNDING_ASSET, amount, bound);
    if (near === "no_route") return { status: "refused", code: "no_quote" };
    if (near === "failed") return { status: "kept", code: "swap_failed" };
    if (near === "pending") return { status: "pending" };
    received = await swapOnAgent(agent, account, FUNDING_ASSET, to, near, bound);
    if (received === "no_route" || received === "failed") return { status: "kept", code: "half_done" };
  }
  if (received === "no_route") return { status: "refused", code: "no_quote" };
  if (received === "failed") return { status: "kept", code: "swap_failed" };
  if (received === "pending") return { status: "pending" };
  if (staysOnAgent(to)) return { status: "done", spent: amount, received, asset: to, kept: true };

  const sent = await agent.withdraw(account, to, received);
  if (sent === "success") return { status: "done", spent: amount, received, asset: to, kept: false };
  if (sent === "undeliverable") {
    // Its value stays with the agent as NEAR, ready for the next purchase or to send home.
    return typeof (await swapOnAgent(agent, account, to, FUNDING_ASSET, received, bound)) === "bigint" ? { status: "returned", code: "not_deliverable", kept: true } : { status: "pending" };
  }
  return { status: "pending" };
}

/** Sends all the NEAR the agent holds to the owner's wallet, where it arrives as plain NEAR. */
export async function sendCashHome(agent: AgentPort, account: OrderAccount): Promise<CashHomeResult> {
  if ((await agent.openLimitOrders(account.agentId)) > 0) return { status: "refused", code: "orders_open" };
  const amount = (await agent.available(account.agentId)).get(FUNDING_ASSET) ?? 0n;
  if (amount <= 0n) return { status: "refused", code: "not_enough" };
  const sent = await agent.withdraw(account, FUNDING_ASSET, amount);
  if (sent === "success") return { status: "done", sent: amount };
  return sent === "pending" ? { status: "pending" } : { status: "failed" };
}
