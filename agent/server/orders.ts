import { createIdempotencyKey, type StatusResponse } from "@near-intents-agent-api/sdk";
import { readFile } from "node:fs/promises";
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner } from "near-api-js";
import type { KeyPairString } from "near-api-js";
import { z } from "zod";
import { toAtomic } from "../policy/units.js";

/** Where an order runs: the user's own account and agent, and the grant that lets Inti act. */
export interface OrderAccount {
  owner: string;
  agentId: string;
  grantToken: string;
}

/** A purchase: spend `amount` of the funding token (atomic units) on `buyAsset`. */
export interface BuyOrder {
  buyAsset: string;
  amount: bigint;
}

export type BuyResult =
  | { status: "done"; spent: bigint; received: bigint; asset: string }
  | { status: "refused"; code: OrderRefusal }
  | { status: "returned"; code: "no_route" | "swap_failed" }
  | { status: "pending" };

export type OrderRefusal = "asset_not_enabled" | "token_not_allowed" | "over_order_limit" | "over_daily_limit" | "funding_failed" | "not_enough";

/** A sale: send `amount` (atomic) of `from` from the user's wallet and receive `to`, NEAR or another asset. */
export interface ExchangeOrder {
  from: string;
  to: string;
  amount: bigint;
}

export type ExchangeResult =
  | { status: "done"; spent: bigint; received: bigint; asset: string }
  | { status: "refused"; code: OrderRefusal }
  /** `asset` is what went back to the wallet: the asset sold, or NEAR when only the second step failed. */
  | { status: "returned"; code: "no_route" | "swap_failed"; asset: string }
  | { status: "pending" };

/** Reads and the one write Inti may do on the user's account, through its function-call key. */
export interface ChainPort {
  /** Whether `account` has storage on the token contract, so the token can be sent to it. */
  registered(tokenContract: string, account: string): Promise<boolean>;
  /** Per-order and per-day limits for `token`, or null when the user allows no orders in it. */
  limit(owner: string, token: string): Promise<{ perOrder: bigint; perDay: bigint } | null>;
  spentLast24h(owner: string, token: string): Promise<bigint>;
  /** Sends `amount` of `token` from the user's account to their agent, via Spending Limits. */
  fundAgent(owner: string, token: string, amount: bigint): Promise<void>;
  /** The account's balance of a NEP-141 token, atomic. */
  tokenBalance(tokenContract: string, account: string): Promise<bigint>;
}

export type Settled = "success" | "failed" | "pending";

/** The agent's side, through the Agent API under the user's grant. */
export interface AgentPort {
  available(agentId: string): Promise<Map<string, bigint>>;
  /** What a swap would give and cost right now, or null when there is no route. Moves nothing. */
  quote(agentId: string, from: string, to: string, amount: bigint): Promise<SwapQuote | null>;
  swap(account: OrderAccount, from: string, to: string, amount: bigint, minOut: bigint): Promise<Settled>;
  /** Sends `amount` of `asset` from the agent to the owner's NEAR wallet. */
  withdraw(account: OrderAccount, asset: string, amount: bigint): Promise<Settled>;
  /** What a limit order would spend, or why the Agent API would refuse it. Moves nothing. */
  previewLimit(agentId: string, order: LimitBuy): Promise<{ spend: bigint } | { refused: string }>;
  /** Places the order; on success it rests on the agent's balance until it fills, is cancelled or expires. */
  placeLimit(account: OrderAccount, order: LimitBuy): Promise<{ settled: Settled; orderId: string | null }>;
  /** Limit orders that may still spend or return money. */
  openLimitOrders(agentId: string): Promise<number>;
  /** The price bound the user signed for limit orders (basis points), or null when limit orders are not allowed. */
  signedPriceBound(agentId: string): Promise<number | null>;
}

/**
 * A dry swap quote: atomic amounts out, what the route keeps and how long it expects to take.
 * The cost is the Agent API's `fee`: the input's value minus the quoted output's value at current
 * prices, so it moves with the market and is not a fixed commission.
 */
export interface SwapQuote {
  amountOut: bigint;
  minAmountOut: bigint;
  costUsd: string | null;
  costPercent: string | null;
  seconds: number | null;
}

/** A resting buy: receive `quantity` (atomic) of `buyAsset`, paying at most `price` funding tokens per whole unit. */
export interface LimitBuy {
  buyAsset: string;
  quantity: bigint;
  price: string;
  /** RFC 3339, at most 7 days ahead. */
  deadline: string;
}

export type LimitResult =
  | { status: "resting"; orderId: string | null; spend: bigint }
  | { status: "refused"; code: OrderRefusal | "order_refused"; detail?: string }
  | { status: "returned"; code: "placement_failed" }
  | { status: "pending" };

/**
 * Kept between the user's signed price bound and the one Inti checks. The Agent API applies the
 * signed bound only when the order is placed, after the agent is funded; checking a little inside
 * it keeps a moving market from turning an accepted check into a refused order.
 */
export const PRICE_BAND_MARGIN_BPS = 50n;

/** The band Inti checks before funding, from the bound in the user's signed policy. */
export function bandFromPolicy(maxDeviationBps: number): bigint {
  const band = BigInt(maxDeviationBps) - PRICE_BAND_MARGIN_BPS;
  return band > 0n ? band : 0n;
}

/**
 * The least a swap may return: the quote's own minimum, or tighter when the price protection the
 * user signed asks for it. One setting covers both price orders and buying now.
 */
export function protectedMinOut(quote: Pick<SwapQuote, "amountOut" | "minAmountOut">, boundBps: number | null): bigint {
  if (boundBps === null) return quote.minAmountOut;
  // Rounded up, so the floor is never even one unit below the chosen percent.
  const floor = (quote.amountOut * BigInt(10_000 - boundBps) + 9_999n) / 10_000n;
  return floor > quote.minAmountOut ? floor : quote.minAmountOut;
}

/**
 * Whether `price` (funding tokens per whole bought token) is within `bandBps` of the market,
 * from the USD prices of both tokens in micro-dollars.
 */
export function priceInBand(price: string, buyUsdMicro: bigint, fundingUsdMicro: bigint, bandBps: bigint): boolean {
  if (buyUsdMicro <= 0n || fundingUsdMicro <= 0n || bandBps <= 0n) return false;
  // Compare price x fundingUsd with buyUsd at 18 decimals, without floats.
  const scaled = BigInt(toAtomic(price, 18)) * fundingUsdMicro;
  const market = buyUsdMicro * 10n ** 18n;
  const diff = scaled > market ? scaled - market : market - scaled;
  return diff * 10_000n <= market * bandBps;
}

/** The atomic quantity of the bought token that `spend` (atomic funding tokens) pays for at `price`. */
export function buyQuantity(spend: bigint, price: string, buyDecimals: number, fundingDecimals: number): bigint {
  const pricePerWholeAtomic = BigInt(toAtomic(price, fundingDecimals));
  return (spend * 10n ** BigInt(buyDecimals)) / pricePerWholeAtomic;
}

/** The token every order is paid in. */
export const FUNDING_TOKEN = "wrap.near";
export const FUNDING_ASSET = `nep141:${FUNDING_TOKEN}`;
/** How long the agent's balance is polled after funding, and how often. */
const CREDIT_WAIT_MS = 30_000;
const CREDIT_POLL_MS = 2_000;

/** The NEP-141 contract behind an asset id, or null for assets that are not NEAR tokens. */
export function tokenContract(assetId: string): string | null {
  const m = /^nep141:([a-z0-9._-]{2,64})$/.exec(assetId);
  return m?.[1] ?? null;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Runs one market purchase end to end: fund the agent with exactly this order, swap, send the
 * result to the user's wallet. The agent ends empty; anything left behind is picked up by `sweep`.
 */
export async function buy(chain: ChainPort, agent: AgentPort, account: OrderAccount, order: BuyOrder, wait = sleep): Promise<BuyResult> {
  const contract = tokenContract(order.buyAsset);
  // The result can only reach the wallet if the wallet can hold the token.
  if (!contract || !(await chain.registered(contract, account.owner))) return { status: "refused", code: "asset_not_enabled" };
  // Read before any money moves: the user's own price protection decides the least they accept.
  const bound = await agent.signedPriceBound(account.agentId);
  const funded = await fund(chain, agent, account, FUNDING_TOKEN, order.amount, wait);
  if (funded === "pending") return { status: "pending" };
  if (funded !== "funded") return { status: "refused", code: funded };

  const quote = await agent.quote(account.agentId, FUNDING_ASSET, order.buyAsset, order.amount);
  if (quote === null) {
    await agent.withdraw(account, FUNDING_ASSET, order.amount);
    return { status: "returned", code: "no_route" };
  }
  const minOut = protectedMinOut(quote, bound);
  const held = (await agent.available(account.agentId)).get(order.buyAsset) ?? 0n;
  const swapped = await agent.swap(account, FUNDING_ASSET, order.buyAsset, order.amount, minOut);
  if (swapped === "pending") return { status: "pending" };
  if (swapped === "failed") {
    await agent.withdraw(account, FUNDING_ASSET, order.amount);
    return { status: "returned", code: "swap_failed" };
  }
  const received = ((await agent.available(account.agentId)).get(order.buyAsset) ?? 0n) - held;
  if (received <= 0n) return { status: "pending" };
  const sent = await agent.withdraw(account, order.buyAsset, received);
  return sent === "success" ? { status: "done", spent: order.amount, received, asset: order.buyAsset } : { status: "pending" };
}

/**
 * Checks the user's limits for `token` on `amount`, funds the agent with it and waits until the
 * agent holds it.
 */
async function fund(
  chain: ChainPort,
  agent: AgentPort,
  account: OrderAccount,
  token: string,
  amount: bigint,
  wait: (ms: number) => Promise<void>,
): Promise<OrderRefusal | "pending" | "funded"> {
  const asset = `nep141:${token}`;
  const limit = await chain.limit(account.owner, token);
  if (!limit) return "token_not_allowed";
  if (amount > limit.perOrder) return "over_order_limit";
  if ((await chain.spentLast24h(account.owner, token)) + amount > limit.perDay) return "over_daily_limit";
  const before = (await agent.available(account.agentId)).get(asset) ?? 0n;
  try {
    await chain.fundAgent(account.owner, token, amount);
  } catch {
    return "funding_failed";
  }
  for (let waited = 0; waited <= CREDIT_WAIT_MS; waited += CREDIT_POLL_MS) {
    if (((await agent.available(account.agentId)).get(asset) ?? 0n) - before >= amount) return "funded";
    await wait(CREDIT_POLL_MS);
  }
  return "pending";
}

/**
 * Swaps `amount` of `from` into `to` on the agent, never below the user's signed price protection.
 * Returns what arrived, measured as the change in the agent's balance of `to`.
 */
async function swapOnAgent(agent: AgentPort, account: OrderAccount, from: string, to: string, amount: bigint, bound: number | null): Promise<bigint | "no_route" | "failed" | "pending"> {
  const quote = await agent.quote(account.agentId, from, to, amount);
  if (quote === null) return "no_route";
  const held = (await agent.available(account.agentId)).get(to) ?? 0n;
  const swapped = await agent.swap(account, from, to, amount, protectedMinOut(quote, bound));
  if (swapped !== "success") return swapped;
  const received = ((await agent.available(account.agentId)).get(to) ?? 0n) - held;
  return received > 0n ? received : "pending";
}

/**
 * Sells `amount` of `from` from the user's wallet for `to` (NEAR or another asset): funds the agent
 * with exactly that amount within the user's limits for `from`, swaps, and sends the result home.
 * With no direct route it swaps through NEAR on the agent, so nothing passes through the wallet in
 * between. On a failure what the agent holds goes back to the wallet; a slow step is left to `sweep`.
 */
export async function exchange(chain: ChainPort, agent: AgentPort, account: OrderAccount, order: ExchangeOrder, wait = sleep): Promise<ExchangeResult> {
  const fromToken = tokenContract(order.from);
  const toToken = tokenContract(order.to);
  if (!fromToken || !toToken || order.from === order.to || order.from === FUNDING_ASSET) return { status: "refused", code: "asset_not_enabled" };
  // The result can only reach the wallet if the wallet can hold it; NEAR arrives as plain NEAR.
  if (order.to !== FUNDING_ASSET && !(await chain.registered(toToken, account.owner))) return { status: "refused", code: "asset_not_enabled" };
  if ((await chain.tokenBalance(fromToken, account.owner)) < order.amount) return { status: "refused", code: "not_enough" };
  const bound = await agent.signedPriceBound(account.agentId);
  const funded = await fund(chain, agent, account, fromToken, order.amount, wait);
  if (funded === "pending") return { status: "pending" };
  if (funded !== "funded") return { status: "refused", code: funded };

  // Says "returned" only once the money is back; a slow return is left to the sweep.
  const giveBack = async (code: "no_route" | "swap_failed", asset: string, amount: bigint): Promise<ExchangeResult> =>
    (await agent.withdraw(account, asset, amount)) === "success" ? { status: "returned", code, asset } : { status: "pending" };
  const failure = (r: "no_route" | "failed") => (r === "no_route" ? "no_route" : "swap_failed");

  let received = await swapOnAgent(agent, account, order.from, order.to, order.amount, bound);
  if (received === "no_route" && order.to !== FUNDING_ASSET) {
    // No direct route: through NEAR, both steps on the agent.
    const near = await swapOnAgent(agent, account, order.from, FUNDING_ASSET, order.amount, bound);
    if (near === "pending") return { status: "pending" };
    if (typeof near !== "bigint") return giveBack(failure(near), order.from, order.amount);
    received = await swapOnAgent(agent, account, FUNDING_ASSET, order.to, near, bound);
    if (received === "pending") return { status: "pending" };
    if (typeof received !== "bigint") return giveBack(failure(received), FUNDING_ASSET, near);
  }
  if (received === "pending") return { status: "pending" };
  if (typeof received !== "bigint") return giveBack(failure(received), order.from, order.amount);
  const sent = await agent.withdraw(account, order.to, received);
  return sent === "success" ? { status: "done", spent: order.amount, received, asset: order.to } : { status: "pending" };
}

/**
 * Places a limit buy. The agent is funded with exactly what the order spends, and the money rests
 * there until the order fills, is cancelled or expires; `sweep` then sends the result home.
 */
export async function placeLimitBuy(chain: ChainPort, agent: AgentPort, account: OrderAccount, order: LimitBuy, wait = sleep): Promise<LimitResult> {
  const contract = tokenContract(order.buyAsset);
  if (!contract || !(await chain.registered(contract, account.owner))) return { status: "refused", code: "asset_not_enabled" };
  // The preview applies the Agent API's own checks (price bound, minimum) before any money moves.
  const preview = await agent.previewLimit(account.agentId, order);
  if ("refused" in preview) return { status: "refused", code: "order_refused", detail: preview.refused };
  const funded = await fund(chain, agent, account, FUNDING_TOKEN, preview.spend, wait);
  if (funded === "pending") return { status: "pending" };
  if (funded !== "funded") return { status: "refused", code: funded };
  const placed = await agent.placeLimit(account, order);
  if (placed.settled === "success") return { status: "resting", orderId: placed.orderId, spend: preview.spend };
  if (placed.settled === "pending") return { status: "pending" };
  await agent.withdraw(account, FUNDING_ASSET, preview.spend);
  return { status: "returned", code: "placement_failed" };
}

/**
 * Sends everything the agent holds back to the user's wallet. While a limit order is open the
 * funding token stays, since its money may still be resting on the balance. Tokens the wallet
 * cannot hold yet stay until the user enables them.
 */
export async function sweep(chain: ChainPort, agent: AgentPort, account: OrderAccount): Promise<string[]> {
  const sent: string[] = [];
  const ordersOpen = (await agent.openLimitOrders(account.agentId)) > 0;
  for (const [asset, free] of await agent.available(account.agentId)) {
    if (free <= 0n) continue;
    if (asset === FUNDING_ASSET && ordersOpen) continue;
    const contract = tokenContract(asset);
    // NEAR arrives as plain NEAR and needs no registration.
    const deliverable = asset === FUNDING_ASSET || (contract !== null && (await chain.registered(contract, account.owner)));
    if (deliverable && (await agent.withdraw(account, asset, free)) === "success") sent.push(asset);
  }
  return sent;
}

/** A NEAR implicit account: the only kind Inti's users have. */
const IMPLICIT = /^[0-9a-f]{64}$/;

/** Gas for one order: Spending Limits asks for at least 80 TGas. */
const FUND_GAS = 100_000_000_000_000n;

/**
 * Reads Inti's key file and checks that its secret key really is the public key the web app
 * asks users to trust (INTI_KEY_PUBLIC); otherwise every order would fail on chain.
 */
export async function loadIntiKey(path: string, expectedPublicKey: string): Promise<KeyPairString> {
  const file = z.object({ publicKey: z.string(), secretKey: z.string().startsWith("ed25519:") }).parse(JSON.parse(await readFile(path, "utf8")));
  const secret = file.secretKey as KeyPairString;
  const actual = KeyPair.fromString(secret).getPublicKey().toString();
  if (actual !== file.publicKey) throw new Error("Inti key file does not match its public key");
  if (actual !== expectedPublicKey) throw new Error("INTI_KEY_PUBLIC is not the public key of SERVER_INTI_KEY_FILE");
  return secret;
}

/** The chain side over NEAR RPC, signing only with Inti's function-call key. */
export function nearChain(rpcUrl: string, intiSecretKey: KeyPairString): ChainPort {
  const provider = new JsonRpcProvider({ url: rpcUrl });
  const signer = KeyPairSigner.fromSecretKey(intiSecretKey);
  const view = <T>(contractId: string, method: string, args: Record<string, unknown>) =>
    provider.callFunction({ contractId, method, args }) as Promise<T | undefined>;
  return {
    async registered(token, account) {
      return (await view<unknown>(token, "storage_balance_of", { account_id: account })) != null;
    },
    async limit(owner, token) {
      const l = await view<{ per_order: string; per_day: string } | null>(owner, "get_limit", { token });
      return l ? { perOrder: BigInt(l.per_order), perDay: BigInt(l.per_day) } : null;
    },
    async tokenBalance(token, account) {
      return BigInt((await view<string>(token, "ft_balance_of", { account_id: account })) ?? "0");
    },
    async spentLast24h(owner, token) {
      return BigInt((await view<string>(owner, "get_spent_last_24h", { token })) ?? "0");
    },
    async fundAgent(owner, token, amount) {
      if (!IMPLICIT.test(owner)) throw new Error("owner is not an implicit account");
      const account = new Account(owner, provider, signer);
      await account.callFunction({ contractId: owner, methodName: "fund_agent", args: { token, amount: amount.toString() }, gas: FUND_GAS, waitUntil: "FINAL" });
    },
  };
}

/** Longest one execution is followed before it is left to the sweep. */
const SETTLE_WAIT_MS = 30_000;

function settled(status: StatusResponse["status"]): Settled {
  if (status === "SUCCESS") return "success";
  if (status === "FAILED" || status === "REFUNDED") return "failed";
  return "pending";
}

/** Longest one Agent API answer may take; settlement writes can hold for a while by design. */
const REQUEST_TIMEOUT_MS = 150_000;
const atomic = z.string().regex(/^\d+$/);
const balancesSchema = z.object({ balances: z.array(z.object({ asset_id: z.string(), available_raw: atomic })) });
const statusSchema = z.object({ correlation_id: z.string(), status: z.string() });
const decimalString = z.string().regex(/^\d+(\.\d+)?$/);
const dryQuoteSchema = z.object({
  quote: z.object({ amount_out: atomic, min_amount_out: atomic, time_estimate_seconds: z.number().nonnegative().nullish() }),
  fee: z.object({ amount_usd: decimalString, percent: decimalString }).nullish(),
});
const limitPreviewSchema =z.object({ quote: z.object({ spend_amount: atomic }) });
const placedSchema = statusSchema.extend({ details: z.object({ order_id: z.string().nullish() }).nullish() });
const openOrdersSchema = z.object({ data: z.array(z.unknown()) });
const errorSchema = z.object({ errors: z.array(z.object({ code: z.string() })) });
const policySchema = z.object({
  policy: z.object({
    actions: z.array(z.string()),
    limit_order: z.object({ max_deviation_bps: z.number().int().min(0).max(300) }).nullish(),
  }),
});

/** An Agent API answer that was not a success, with its documented error code. */
export class AgentApiRefusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`agent api answered ${status} ${code}`);
  }
}

/**
 * The agent side over the NEAR Intents Agent API (docs.agentsonintents.com: executions, grants).
 * Partner keys from the partner portal are not in the `naa_` form the SDK client checks for, so
 * the routes are called directly with the key in X-API-Key, as for agent creation.
 */
export function agentApiPort(apiKey: string, baseUrl: string, fetcher: typeof fetch = fetch): AgentPort {
  const call = async (path: string, body?: unknown, headers: Record<string, string> = {}): Promise<unknown> => {
    const res = await fetcher(new URL(path, baseUrl), {
      method: body === undefined ? "GET" : "POST",
      headers: { "X-API-Key": apiKey, ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      const doc = errorSchema.safeParse(await res.json().catch(() => null));
      throw new AgentApiRefusal(res.status, doc.success ? (doc.data.errors[0]?.code ?? "unknown") : "unknown");
    }
    return res.json();
  };
  const run = async (account: OrderAccount, path: string, body: Record<string, unknown>): Promise<Settled> => {
    const started = statusSchema.parse(await call(path, body, { "X-Grant-Token": account.grantToken, "Idempotency-Key": createIdempotencyKey() }));
    const first = settled(started.status as StatusResponse["status"]);
    if (first !== "pending") return first;
    const query = `/v1/status?correlation_id=${encodeURIComponent(started.correlation_id)}&wait_ms=${SETTLE_WAIT_MS}`;
    return settled(statusSchema.parse(await call(query)).status as StatusResponse["status"]);
  };
  const limitBody = (order: LimitBuy) => ({
    base_asset: order.buyAsset,
    quote_asset: FUNDING_ASSET,
    side: "buy",
    quantity: order.quantity.toString(),
    price: order.price,
    deadline: order.deadline,
  });
  const agentPath = (agentId: string, route: string) => `/v1/agents/${encodeURIComponent(agentId)}/${route}`;
  return {
    async available(agentId) {
      const view = balancesSchema.parse(await call(`${agentPath(agentId, "balances")}?source=public`));
      return new Map(view.balances.map((b) => [b.asset_id, BigInt(b.available_raw)] as const));
    },
    async quote(agentId, from, to, amount) {
      try {
        const dry = dryQuoteSchema.parse(await call(agentPath(agentId, "swap"), { origin_asset: from, destination_asset: to, amount: amount.toString(), dry: true }));
        return {
          amountOut: BigInt(dry.quote.amount_out),
          minAmountOut: BigInt(dry.quote.min_amount_out),
          costUsd: dry.fee?.amount_usd ?? null,
          costPercent: dry.fee?.percent ?? null,
          seconds: dry.quote.time_estimate_seconds ?? null,
        };
      } catch {
        return null;
      }
    },
    swap: (account, from, to, amount, minOut) =>
      run(account, agentPath(account.agentId, "swap"), { origin_asset: from, destination_asset: to, amount: amount.toString(), min_amount_out: minOut.toString() }),
    withdraw: (account, asset, amount) =>
      run(account, agentPath(account.agentId, "withdraw"), { asset, amount: amount.toString(), chain: "near", recipient: account.owner }),
    async previewLimit(agentId, order) {
      try {
        const preview = limitPreviewSchema.parse(await call(agentPath(agentId, "limit-orders"), { ...limitBody(order), dry: true }));
        return { spend: BigInt(preview.quote.spend_amount) };
      } catch (error) {
        return { refused: error instanceof AgentApiRefusal ? error.code : "unavailable" };
      }
    },
    async placeLimit(account, order) {
      const headers = { "X-Grant-Token": account.grantToken, "Idempotency-Key": createIdempotencyKey() };
      let placed = placedSchema.parse(await call(agentPath(account.agentId, "limit-orders"), limitBody(order), headers));
      if (settled(placed.status as StatusResponse["status"]) === "pending") {
        placed = placedSchema.parse(await call(`/v1/status?correlation_id=${encodeURIComponent(placed.correlation_id)}&wait_ms=${SETTLE_WAIT_MS}`));
      }
      return { settled: settled(placed.status as StatusResponse["status"]), orderId: placed.details?.order_id ?? null };
    },
    async signedPriceBound(agentId) {
      const view = policySchema.parse(await call(agentPath(agentId, "policy")));
      return view.policy.actions.includes("limit_order") ? (view.policy.limit_order?.max_deviation_bps ?? null) : null;
    },
    async openLimitOrders(agentId) {
      return openOrdersSchema.parse(await call(`${agentPath(agentId, "limit-orders")}?open=true&limit=100`)).data.length;
    },
  };
}
