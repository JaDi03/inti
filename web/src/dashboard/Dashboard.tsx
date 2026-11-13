import { ArrowDownToLine, Check, ChevronDown, ExternalLink, Eye, EyeOff, HandCoins, KeyRound, Snowflake, Loader2, Lock, Pause, Play, Plus, Power, RefreshCw, ShieldCheck, Sparkles, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ASSET_KEYS, ASSETS, type AssetKey } from "../../../agent/policy/assets";
import { HELD_ASSETS, HELD_KEYS, type HeldKey } from "../../../agent/policy/heldAssets";
import { fromAtomic } from "../../../agent/policy/units";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { DECIMALS } from "../assets/AssetsPanel";
import type { LimitsClient, LimitsStatus } from "../limits/client";
import { useOwnerSigner } from "../limits/ConfirmSigning";
import type { LimitsConfig } from "../limits/config";
import { PasskeyProtection } from "../limits/PasskeyProtection";
import { display } from "../limits/SpendingLimitsPanel";
import { FreezeError, setAgentFrozen } from "../agent/freeze";
import { fetchDashboard, sellHeld, type DashboardData, type HeldSale } from "./dashboardClient";
import { AddressLine } from "./AddressLine";
import { GrantRenewal } from "./GrantRenewal";
import { PriceProtection } from "./PriceProtection";
import { ReceiveDialog } from "./Receive";
import { shortAmount } from "./shortAmount";

type Installed = Extract<LimitsStatus, { kind: "installed" }>;
type AssetRow = { key: AssetKey; enabled: boolean; balance: bigint };

/**
 * One color per asset that matches its brand (Bitcoin orange, Ether's blue, Zcash yellow), in the
 * same light shade with dark text so it reads in both themes.
 */
const TILE: Record<AssetKey, string> = {
  bitcoin: "bg-orange-300",
  ethereum: "bg-indigo-200",
  zcash: "bg-yellow-300",
};

/** Gold's yellow, the euro's blue and Solana's purple, in the same light shades. */
const HELD_TILE: Record<HeldKey, string> = {
  gold: "bg-amber-200",
  euro: "bg-sky-300",
  solana: "bg-purple-300",
};

/** The areas of the dashboard, by what each asset is. */
const GROUPS: { title: string; keys: AssetKey[] }[] = [
  { title: "Crypto", keys: ASSET_KEYS.filter((k) => ASSETS[k].kind === "crypto") },
  { title: "Privacy", keys: ASSET_KEYS.filter((k) => ASSETS[k].kind === "privacy") },
];

const NEAR_DECIMALS = 24;
/** Shortest time between the tap that asks and the tap that sells. */
const CONFIRM_DELAY_MS = 500;
const HIDDEN = "••••";
/**
 * What one order reserves from Inti's fee allowance: 100 TGas at NEAR's lowest gas price
 * (0.0001 NEAR per TGas). Below it the next order cannot be paid.
 */
const ONE_ORDER_FEE_YOCTO = 10n ** 22n; // 0.01 NEAR

/** Dollar value for display only; amounts stay exact in atomic units everywhere else. */
function usd(amount: string, price: number | null | undefined): number | null {
  const n = Number(amount);
  return price == null || !Number.isFinite(n) ? null : n * price;
}

const money = (v: number | null) => (v === null ? "--" : v.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const nearText = (atomic: bigint) => display(atomic, NEAR_DECIMALS);

export interface DashboardState {
  data: DashboardData | null;
  assets: AssetRow[] | null;
  loading: boolean;
  /** Reads everything again; `quiet` replaces the numbers in place without showing a spinner. */
  load: (quiet?: boolean) => Promise<void>;
}

/** An on/off choice of the viewer, remembered in this browser only. */
function useRememberedSwitch(key: string, initial: boolean): [boolean, () => void] {
  const [on, setOn] = useState(() => {
    try {
      const saved = localStorage.getItem(key);
      return saved === null ? initial : saved === "1";
    } catch {
      return initial;
    }
  });
  const toggle = () =>
    setOn((v) => {
      try {
        localStorage.setItem(key, v ? "0" : "1");
      } catch {
        // Storage can be blocked; the choice then lasts for this visit.
      }
      return !v;
    });
  return [on, toggle];
}

/** Whether one part of the screen shows its amounts as dots; each part has its own switch. */
export function useHideAmounts(part: "address" | "money" | "rules"): { hidden: boolean; toggleHidden: () => void } {
  const [hidden, toggleHidden] = useRememberedSwitch(`inti-hide-${part}`, false);
  return { hidden, toggleHidden };
}

/** Prices, the agent's rules and the wallet's assets, read once for both halves of the dashboard. */
function useDashboard(
  address: string,
  client: LimitsClient,
  status: Installed,
  getAccessToken: () => Promise<string | null>,
  grantSigned: boolean,
): DashboardState {
  const [data, setData] = useState<DashboardData | null>(null);
  const [assets, setAssets] = useState<AssetRow[] | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    async (quiet = false) => {
      if (!quiet) setLoading(true);
      try {
        const token = await getAccessToken();
        const [server, rows] = await Promise.all([token ? fetchDashboard(token) : Promise.resolve(null), client.assets(address).catch(() => null)]);
        // A failed read keeps what is already on screen instead of blanking it.
        if (server) setData(server);
        if (rows) setAssets(rows);
      } finally {
        if (!quiet) setLoading(false);
      }
    },
    [address, client, getAccessToken],
  );

  // Read again only when the account's balances, limits or Inti's permission really changed, not on
  // every re-render. The first read says it is reading; later ones replace the numbers in place.
  const balances = `${status.available}:${status.spendable}:${status.spentToday}:${status.intiConnected}:${status.intiFeesLeft}`;
  const readOnce = useRef(false);
  useEffect(() => {
    void load(readOnce.current);
    readOnce.current = true;
  }, [load, balances, grantSigned]);

  return { data, assets, loading, load };
}

interface MoneyProps {
  address: string;
  config: LimitsConfig;
  client: LimitsClient;
  status: Installed;
  state: DashboardState;
  /** Opens the Spending limits window (add NEAR, edit limits, pause or turn off Inti). */
  onManage: () => void;
  /** Re-reads the account's own balances (NEAR, NEAR for orders), which the dashboard does not read. */
  onChanged: () => void;
  getAccessToken: () => Promise<string | null>;
  /** The wallet card, the asset areas, or both. */
  part: "wallet" | "assets" | "both";
  className?: string;
}

/** The user's money: the wallet and the assets Inti can buy, each enabled from its own tile. */
export function MoneyPanel({ address, config, client, status, state, onManage, onChanged, getAccessToken, part, className }: MoneyProps) {
  const { signer, confirmDialog } = useOwnerSigner(address, config);
  const { data, assets, loading, load } = state;
  const { hidden, toggleHidden } = useHideAmounts("money");
  const [receiving, setReceiving] = useState(false);
  const [busy, setBusy] = useState<AssetKey | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastTx, setLastTx] = useState<string | null>(null);

  const enable = async (key: AssetKey) => {
    setBusy(key);
    setError(null);
    try {
      setLastTx(await client.enableAsset(address, signer, key));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : `${ASSETS[key].name} could not be enabled.`);
    } finally {
      setBusy(null);
    }
  };

  // Selling what the agent keeps takes two taps, since it moves real money: the first only asks.
  const [confirming, setConfirming] = useState<HeldKey | null>(null);
  const [selling, setSelling] = useState<HeldKey | null>(null);
  const [saleNote, setSaleNote] = useState<string | null>(null);
  useEffect(() => {
    if (!confirming) return;
    const timer = setTimeout(() => setConfirming(null), 5_000);
    return () => clearTimeout(timer);
  }, [confirming]);

  // When the first tap asked; a second tap sooner than CONFIRM_DELAY_MS is a double click, not a yes.
  const askedAt = useRef(0);
  const pressSell = async (key: HeldKey) => {
    if (selling) return;
    if (confirming !== key) {
      setSaleNote(null);
      setConfirming(key);
      askedAt.current = Date.now();
      return;
    }
    if (Date.now() - askedAt.current < CONFIRM_DELAY_MS) return;
    setConfirming(null);
    setSelling(key);
    try {
      const token = await getAccessToken();
      const sale: HeldSale = token ? await sellHeld(token, key) : { status: "error", code: "unauthorized" };
      setSaleNote(saleMessage(sale, HELD_ASSETS[key].name));
      if (sale.status === "done" || sale.status === "pending") {
        onChanged();
        await load(true);
      }
    } finally {
      setSelling(null);
    }
  };

  const nearPrice = data?.prices.near ?? null;
  const inWallet = usd(fromAtomic(status.available.toString(), NEAR_DECIMALS), nearPrice);
  const forOrders = usd(fromAtomic(status.spendable.toString(), NEAR_DECIMALS), nearPrice);
  // NEAR the network keeps aside for the account's storage (mostly the Spending Limits contract): shown, but not in the total, since it cannot be used.
  const locked = usd(fromAtomic(status.setAside.toString(), NEAR_DECIMALS), nearPrice);
  const assetValues = (assets ?? []).map((r) => usd(fromAtomic(r.balance.toString(), DECIMALS[r.key]), data?.prices[r.key]) ?? 0);
  const total = inWallet === null || forOrders === null ? null : [inWallet, forOrders, ...assetValues].reduce((a, b) => a + b, 0);
  const show = (text: string) => (hidden ? HIDDEN : text);

  return (
    <div className={cn("flex flex-col gap-4", className)}>
      {part !== "assets" && (
      <section className="rounded-3xl border bg-card p-5">
        <div className="flex items-start justify-between">
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <img src="/tokens/near.png" alt="" width={20} height={20} className="size-5 rounded-full bg-white" /> Your wallet
          </p>
          <div className="-mt-1 -mr-2 flex">
            <Button variant="ghost" size="icon-sm" aria-label={hidden ? "Show amounts" : "Hide amounts"} onClick={toggleHidden}>
              {hidden ? <EyeOff /> : <Eye />}
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Refresh"
              disabled={loading}
              onClick={() => {
                onChanged();
                void load();
              }}
            >
              <RefreshCw className={cn(loading && "animate-spin")} />
            </Button>
          </div>
        </div>
        <p className="mt-1 h-10 text-4xl font-semibold tracking-tight tabular-nums">
          {hidden ? <span className="text-3xl tracking-[0.25em]">●●●●●●</span> : money(total)}
        </p>
        <dl className="mt-4 flex flex-col gap-2 text-sm">
          <BalanceRow label="In your wallet" near={show(`${nearText(status.available)} NEAR`)} value={show(money(inWallet))} />
          <BalanceRow label="For orders" near={show(`${nearText(status.spendable)} NEAR`)} value={show(money(forOrders))} highlight />
          <BalanceRow label="Kept for account storage" near={show(`${nearText(status.setAside)} NEAR`)} value={show(money(locked))} />
        </dl>
        <div className="mt-4 grid grid-cols-[auto_1fr] gap-2">
          <Button variant="outline" className="rounded-full" onClick={() => setReceiving(true)}>
            <ArrowDownToLine /> Receive
          </Button>
          <Button className="rounded-full" onClick={onManage}>
            <Plus /> Add NEAR for orders
          </Button>
        </div>
      </section>
      )}
      {receiving && <ReceiveDialog address={address} onClose={() => setReceiving(false)} />}

      {part !== "wallet" && (
        <div className="-mb-2 px-1">
          <h2 className="font-heading text-2xl font-semibold text-foreground">Your portfolio</h2>
          {/* Tells these areas apart from what the agent holds, further down. */}
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">In your wallet</p>
        </div>
      )}
      {part !== "wallet" && GROUPS.map((group) => (
      <section key={group.title}>
        <h3 className="mb-2.5 px-1 font-heading text-xl font-semibold text-foreground">{group.title}</h3>
        <ul className="grid auto-rows-fr grid-cols-2 gap-3">
          {group.keys.map((key, i) => {
            const a = ASSETS[key];
            const row = assets?.find((r) => r.key === key);
            const amount = row ? fromAtomic(row.balance.toString(), DECIMALS[key]) : null;
            const price = data?.prices[key];
            // An odd tile out takes the whole row, so no area ends with a gap.
            const wide = group.keys.length % 2 === 1 && i === group.keys.length - 1;
            return (
              <li key={key} className={cn("flex min-h-36 flex-col justify-between rounded-3xl p-4 text-neutral-950", TILE[key], wide && "col-span-2")}>
                <div className="flex items-start justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <img src={`/tokens/${key}.png`} alt="" width={36} height={36} className={cn("size-9 shrink-0 rounded-full bg-white object-cover ring-2 ring-white/70")} />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold uppercase tracking-wide">{a.name}</p>
                      <p className="text-xs opacity-70">{a.symbol}</p>
                    </div>
                  </div>
                  {row?.enabled && (
                    <span className="flex shrink-0 items-center gap-1 rounded-full bg-primary px-2 py-0.5 text-[11px] font-semibold text-primary-foreground shadow-sm">
                      <Check className="size-3" /> Enabled
                    </span>
                  )}
                </div>
                <div>
                  {row?.enabled ? (
                    <>
                      {/* What the owner holds, not the asset's price, which is the line below. */}
                      <p className="text-[11px] font-semibold uppercase tracking-wide opacity-70">Your balance</p>
                      <p className="text-2xl font-semibold tabular-nums">{show(money(amount === null ? null : usd(amount, price)))}</p>
                      <p className="truncate text-xs tabular-nums opacity-70" title={hidden ? "" : (amount ?? "")}>
                        {show(`${amount === null ? "--" : shortAmount(amount)} ${a.symbol}`)}
                      </p>
                    </>
                  ) : (
                    <Button
                      size="sm"
                      className="rounded-full bg-neutral-950 text-white hover:bg-neutral-800"
                      disabled={busy !== null || !assets}
                      onClick={() => void enable(key)}
                    >
                      {busy === key ? <Loader2 className="animate-spin" /> : null} Enable
                    </Button>
                  )}
                  <p className="mt-1 text-[11px] tabular-nums opacity-70">{price == null ? "No price right now" : `Price: 1 ${a.symbol} = ${money(price)}`}</p>
                </div>
              </li>
            );
          })}
        </ul>
      </section>
      ))}
      {part !== "wallet" && (
        <p className="-mt-2 px-1 text-xs text-muted-foreground">Enabling an asset costs 0.00125 NEAR, once.</p>
      )}

      {part !== "wallet" && (
        <section>
          <h3 className="px-1 font-heading text-xl font-semibold text-foreground">Held by your agent</h3>
          <p className="mb-2.5 px-1 text-xs text-muted-foreground">Kept privately by your agent. Sell them for NEAR anytime.</p>
          <ul className="grid auto-rows-fr grid-cols-2 gap-3">
            {HELD_KEYS.map((key, i) => {
              const a = HELD_ASSETS[key];
              const held = data?.agent?.held;
              // Null while the agent's balance cannot be read; an asset it does not hold reads as zero.
              const amount = held ? (held.find((h) => h.asset === key)?.amount ?? "0") : null;
              const price = data?.prices[key];
              const wide = HELD_KEYS.length % 2 === 1 && i === HELD_KEYS.length - 1;
              return (
                <li key={key} className={cn("flex min-h-36 flex-col justify-between rounded-3xl p-4 text-neutral-950", HELD_TILE[key], wide && "col-span-2")}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <img src={`/tokens/${key}.png`} alt="" width={36} height={36} className="size-9 shrink-0 rounded-full bg-white object-cover ring-2 ring-white/70" />
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold uppercase tracking-wide">{a.name}</p>
                        <p className="text-xs opacity-70">{a.symbol}</p>
                      </div>
                    </div>
                    <SellHeldButton
                      name={a.name}
                      state={selling === key ? "selling" : confirming === key ? "confirm" : "idle"}
                      blockedBy={
                        amount === null || Number(amount) === 0 ? "Nothing to sell" : !data?.agent?.grantUntil ? "Renew Inti's permission to sell" : selling !== null ? "Another sale is running" : null
                      }
                      onPress={() => void pressSell(key)}
                    />
                  </div>
                  <div>
                    {/* The first tap asks here, on the card the owner is looking at. */}
                    {confirming === key ? (
                      <p className="text-[11px] font-bold uppercase tracking-wide">Tap ✓ again to sell</p>
                    ) : (
                      <p className="text-[11px] font-semibold uppercase tracking-wide opacity-70">With your agent</p>
                    )}
                    <p className="text-2xl font-semibold tabular-nums">{show(money(amount === null ? null : usd(amount, price)))}</p>
                    <p className="truncate text-xs tabular-nums opacity-70" title={hidden ? "" : (amount ?? "")}>
                      {show(`${amount === null ? "--" : shortAmount(amount)} ${a.symbol}`)}
                    </p>
                    <p className="mt-1 text-[11px] tabular-nums opacity-70">{price == null ? "No price right now" : `Price: 1 ${a.symbol} = ${money(price)}`}</p>
                  </div>
                </li>
              );
            })}
          </ul>
          {saleNote && (
            <p role="status" className="mt-2 px-1 text-sm">
              {saleNote}
            </p>
          )}
        </section>
      )}

      {error && <p className="break-words text-sm text-destructive">{error}</p>}
      {lastTx && (
        <a className="inline-flex items-center gap-1 text-sm text-primary underline-offset-4 hover:underline" href={config.explorerTxUrl(lastTx)} target="_blank" rel="noreferrer">
          View last transaction <ExternalLink className="size-3.5" />
        </a>
      )}
      {confirmDialog}
    </div>
  );
}

interface RulesProps {
  address: string;
  config: LimitsConfig;
  client: LimitsClient;
  status: Installed;
  state: DashboardState;
  /** Opens the Spending limits window to edit the limits. */
  onManage: () => void;
  /** Re-reads the account after the user changed something on it. */
  onChanged: () => void;
  getAccessToken: () => Promise<string | null>;
  className?: string;
}

/** The rules around the money: Spending Limits on the user's account and the agent's signed rules. */
export function RulesPanel({ address, config, client, status, state, onManage, onChanged, getAccessToken, className }: RulesProps) {
  const { signer, confirmDialog } = useOwnerSigner(address, config);
  const { data, loading } = state;
  const { hidden, toggleHidden } = useHideAmounts("rules");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const policy = data?.agent?.policy;
  const agentAccount = data?.agent?.account;
  // Inti's key is on, but what is left for fees cannot pay one more order.
  const feesOut = (status.intiConnected && status.intiFeesLeft !== null && status.intiFeesLeft < ONE_ORDER_FEE_YOCTO);
  const orders = data?.agent?.orders;
  const near = (atomic: bigint) => (hidden ? HIDDEN : nearText(atomic));

  const [freezing, setFreezing] = useState(false);
  const [freezeNote, setFreezeNote] = useState<string | null>(null);
  const setFrozen = async (frozen: boolean) => {
    if (!policy || policy.maxDeviationBps === null || !agentAccount) return;
    setFreezing(true);
    setFreezeNote(null);
    try {
      const token = await getAccessToken();
      if (!token) throw new FreezeError("Your session expired. Sign in again and retry.");
      const outcome = await setAgentFrozen({ accessToken: token, accountId: address, agentAccount, maxDeviationBps: policy.maxDeviationBps, config, provider: client.provider, signer, frozen });
      if (outcome === "processing") setFreezeNote("NEAR Intents is still saving the change. Check again in a minute.");
      else setFreezeNote(frozen ? "Your agent is frozen. It can do nothing until you unfreeze it." : "Your agent is unfrozen. Inti can trade for you again.");
      await state.load(true);
    } catch (e) {
      setFreezeNote(e instanceof Error ? e.message : "Your agent's state could not be changed.");
    } finally {
      setFreezing(false);
    }
  };

  const pauseOrResume = async () => {
    setBusy(true);
    setError(null);
    try {
      await (status.intiConnected ? client.disconnectInti(address, signer) : client.reconnectInti(address, signer));
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The transaction failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={cn("flex flex-col gap-4", className)}>
      <FoldCard
        id="limits"
        icon={<ShieldCheck className="size-4 text-primary" />}
        title="Spending limits"
        extra={
          <span className={cn("flex items-center gap-1.5 text-xs", feesOut ? "font-medium text-destructive" : "text-muted-foreground")}>
            <span className={cn("size-2 rounded-full", feesOut ? "bg-destructive" : status.intiConnected ? "bg-primary" : "bg-muted-foreground")} />
            {feesOut ? "Inti can't trade" : status.intiConnected ? "Inti is on" : "Inti is paused"}
          </span>
        }
        extraWhenOpen={
          <Button variant="ghost" size="icon-sm" aria-label={hidden ? "Show amounts" : "Hide amounts"} onClick={toggleHidden}>
            {hidden ? <EyeOff /> : <Eye />}
          </Button>
        }
      >
        <p className="mt-1 text-xs text-muted-foreground">A contract on your own account. Inti can only send what these limits allow, and only to your agent.</p>
        {status.limit ? (
          <>
            <div className="mt-4 flex justify-between text-sm">
              <span className="text-muted-foreground">Used in the last 24 h</span>
              <span className="tabular-nums">
                {near(status.spentToday)} of {near(status.limit.perDay)} NEAR
              </span>
            </div>
            <div className="mt-1.5 h-2.5 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-all"
                style={{ width: `${status.limit.perDay > 0n ? Math.min(Number((status.spentToday * 100n) / status.limit.perDay), 100) : 0}%` }}
              />
            </div>
            <div className="mt-3 flex justify-between text-sm">
              <span className="text-muted-foreground">Most per order</span>
              <span className="tabular-nums">{near(status.limit.perOrder)} NEAR</span>
            </div>
          </>
        ) : (
          <p className="mt-3 text-sm">No limit set yet.</p>
        )}
        <div className="mt-3 text-sm">
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">Money can only go to</span>
            {agentAccount &&
              (agentAccount === status.agent ? (
                <span className="flex items-center gap-1 text-xs text-primary">
                  <Check className="size-3.5" /> Your agent
                </span>
              ) : (
                <span className="text-xs text-destructive">Not your agent&apos;s wallet</span>
              ))}
          </div>
          <AddressLine address={status.agent} label="destination" className="mt-1" />
        </div>
        {status.intiFeesLeft !== null && (
          <>
            <div className="mt-2 flex justify-between text-sm">
              <span className="text-muted-foreground">Fees left for Inti</span>
              <span className="tabular-nums">
                {near(status.intiFeesLeft)} of {near(config.intiKeyAllowanceYocto)} NEAR
              </span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">Inti pays each order&apos;s network fee from this. It is one total, not per day. Pausing and resuming Inti starts it over.</p>
            {feesOut && (
              <p role="alert" className="mt-2 rounded-2xl bg-destructive/10 px-3 py-2 text-sm text-destructive">
                Inti&apos;s fees ran out, so it cannot place orders. Pause and resume Inti to start them over.
              </p>
            )}
          </>
        )}
        <div className="mt-3 flex items-start gap-2 rounded-2xl bg-muted px-3 py-2 text-xs text-muted-foreground">
          <Lock className="mt-0.5 size-3.5 shrink-0" />
          <span>
            The network keeps {near(status.setAside)} NEAR of your account aside while these rules live on it. It comes back when you turn Inti off.
          </span>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2">
          <Button variant="outline" className="rounded-full" disabled={busy} onClick={onManage}>
            Edit limits
          </Button>
          <Button variant={status.intiConnected ? "outline" : "default"} className="rounded-full" disabled={busy} onClick={() => void pauseOrResume()}>
            {busy ? <Loader2 className="animate-spin" /> : status.intiConnected ? <Pause /> : <Play />}
            {status.intiConnected ? "Pause Inti" : "Resume Inti"}
          </Button>
        </div>
        {error && <p className="mt-2 break-words text-sm text-destructive">{error}</p>}
      </FoldCard>
      {confirmDialog}

      <FoldCard
        id="agent"
        icon={<Sparkles className="size-4 text-primary" />}
        title="Your agent's rules"
        // Ice blue while frozen, so the state shows at a glance.
        className={policy?.frozen ? "border-sky-300 bg-sky-50 dark:border-sky-700 dark:bg-sky-950/50" : undefined}
        extra={
          policy?.frozen ? (
            <span className="flex items-center gap-1">
              <span className="flex items-center gap-1 rounded-full bg-sky-100 px-2.5 py-1 text-xs font-semibold text-sky-900">
                <Snowflake className="size-3.5" /> Frozen
              </span>
              <Button
                variant="outline"
                size="sm"
                className="h-7 rounded-full px-2.5 text-xs"
                title="Let Inti trade for you again, within your rules"
                disabled={freezing || !agentAccount || policy.maxDeviationBps === null}
                onClick={() => void setFrozen(false)}
              >
                {freezing && <Loader2 className="animate-spin" />} Unfreeze
              </Button>
            </span>
          ) : (
            <Button
              size="sm"
              className="h-7 rounded-full bg-sky-200 px-2.5 text-xs text-sky-950 hover:bg-sky-300"
              title="Stop your agent at once: it can do nothing until you unfreeze it"
              disabled={freezing || !policy || !agentAccount || policy.maxDeviationBps === null}
              onClick={() => void setFrozen(true)}
            >
              {freezing ? <Loader2 className="animate-spin" /> : <Snowflake />} Freeze
            </Button>
          )
        }
      >
        <p className="mt-1 text-xs text-muted-foreground">Signed by you on NEAR Intents. Nobody can change them without your signature, not even Inti.</p>
        {agentAccount && (
          <div className="mt-3">
            <p className="text-sm">Agent wallet</p>
            <AddressLine address={agentAccount} label="agent wallet" className="mt-1" />
          </div>
        )}
        {policy ? (
          <ul className="mt-3 flex flex-col gap-2 text-sm">
            <Rule ok={policy.sendsOnlyToOwner} text="Sends only to you" />
            {policy.destinations.map((d) => (
              <li key={d} className="-mt-1 ml-6 text-xs text-muted-foreground">
                <span className="break-all font-mono">{d}</span>
                {d === address && <span className="ml-1 text-foreground">(this wallet)</span>}
              </li>
            ))}
            <Rule ok={policy.canBuyNow} text="Can buy now" />
            <Rule ok={policy.canPlaceLimitOrders} text={`Can place price orders${policy.maxPriceGapPercent ? `, at most ${policy.maxPriceGapPercent}% from the market` : ""}`} />
            {policy.maxActionsPerHour !== null && <Rule ok text={`At most ${policy.maxActionsPerHour} actions per hour`} />}
            {policy.frozen && <Rule ok={false} text="Frozen: it can do nothing" />}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-muted-foreground">{loading ? "Reading your agent..." : "Your agent's rules are not available right now."}</p>
        )}
        {policy && (
          <PriceProtection
            address={address}
            signer={signer}
            getAccessToken={getAccessToken}
            current={policy.maxDeviationBps}
            nextChangeAt={policy.nextChangeAt}
            onSigned={() => void state.load(true)}
          />
        )}
        {data?.agent && (
          <GrantRenewal address={address} signer={signer} getAccessToken={getAccessToken} grantUntil={data.agent.grantUntil} onSigned={() => void state.load(true)} />
        )}
        <h3 className="mt-4 text-sm font-medium">Orders waiting for a price</h3>
        {orders && orders.length > 0 ? (
          <ul className="mt-2 flex flex-col gap-2">
            {orders.map((o, i) => (
              <li key={`${o.deadline}-${i}`} className="flex items-center justify-between gap-2 rounded-2xl border px-3 py-2 text-sm">
                <span>
                  {hidden ? HIDDEN : (o.amount ?? "--")} {o.asset ? ASSETS[o.asset].symbol : "?"} at {o.priceUsd ? `$${o.priceUsd}` : `${o.priceNear} NEAR`}
                </span>
                <span className="text-xs text-muted-foreground">until {new Date(o.deadline).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-sm text-muted-foreground">None right now.</p>
        )}
      </FoldCard>
      {/* Outside the card, so it shows even while the card is folded. */}
      {freezeNote && (
        <p role="status" className="-mt-2 break-words px-1 text-sm">
          {freezeNote}
        </p>
      )}
    </div>
  );
}

/**
 * A card the user can fold to its title; it remembers how the user left it. `extra` shows next to
 * the title always, `extraWhenOpen` only while the card is open (controls for what it shows).
 */
function FoldCard({
  id,
  icon,
  title,
  extra,
  extraWhenOpen,
  className,
  children,
}: {
  id: string;
  icon: React.ReactNode;
  title: string;
  extra?: React.ReactNode;
  extraWhenOpen?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  const [open, toggle] = useRememberedSwitch(`inti-open-${id}`, true);
  return (
    <section className={cn("rounded-3xl border bg-card transition-[padding]", open ? "p-5" : "px-5 py-3", className)}>
      <div className="flex items-center gap-1">
        <button className="-my-1 flex min-w-0 flex-1 items-center gap-2 py-1 text-left font-medium" aria-expanded={open} onClick={toggle}>
          {icon}
          <h2 className="truncate font-heading text-[17px] font-semibold">{title}</h2>
          <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground transition-transform", !open && "-rotate-90")} />
        </button>
        {(extra || (open && extraWhenOpen)) && (
          <div className={cn("flex shrink-0 items-center gap-1", open && extraWhenOpen && "-mr-2")}>
            {extra}
            {open && extraWhenOpen}
          </div>
        )}
      </div>
      {open && children}
    </section>
  );
}

interface SecurityProps {
  address: string;
  config: LimitsConfig;
  client: LimitsClient;
  status: Installed;
  /** Opens Privy's own window that shows the wallet's key; the key never reaches Inti's code. */
  onExport: () => void;
  onChanged: () => void;
  className?: string;
}

/** What protects the account and the ways out: passkey, the wallet's key, and turning Inti off. */
export function SecurityPanel({ address, config, client, status, onExport, onChanged, className }: SecurityProps) {
  const { signer, confirmDialog } = useOwnerSigner(address, config);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const turnOff = async () => {
    setBusy(true);
    setError(null);
    try {
      const plan = client.releasePlan(address, status.spendable, status.intiConnected);
      await signer.approveAll(plan);
      await client.send(address, signer, plan);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The transaction failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
    <FoldCard id="security" icon={<Lock className="size-4 text-primary" />} title="Security" className={className}>
      <div className="mt-3">
        <PasskeyProtection />
      </div>
      <div className="mt-4 border-t pt-4">
        <p className="text-sm font-medium">Your wallet&apos;s key</p>
        <p className="mt-1 text-xs text-muted-foreground">The wallet is yours. Its key opens it in any NEAR wallet. Keep it secret: anyone with it controls your money.</p>
        <Button variant="outline" size="sm" className="mt-2 rounded-full" onClick={onExport}>
          <KeyRound /> Export wallet
        </Button>
      </div>
      <div className="mt-4 border-t pt-4">
        <p className="text-sm font-medium">Turn off Inti</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Inti stops working and your whole balance is back to normal, including the NEAR set aside for Inti. You can turn Inti on again later.
        </p>
        <Button variant="outline" size="sm" className="mt-2 rounded-full" disabled={busy} onClick={() => void turnOff()}>
          {busy ? <Loader2 className="animate-spin" /> : <Power />} Turn off Inti
        </Button>
      </div>
      {error && <p className="mt-2 break-words text-sm text-destructive">{error}</p>}
    </FoldCard>
    {confirmDialog}
    </>
  );
}

interface LayoutProps {
  address: string;
  config: LimitsConfig;
  client: LimitsClient;
  status: Installed;
  getAccessToken: () => Promise<string | null>;
  onManage: () => void;
  onExport: () => void;
  /** Re-reads the account after the user changed something on it. */
  onChanged: () => void;
  /** On a phone, which one shows: the chat or the portfolio. */
  view: "chat" | "portfolio";
  /** True once the user signed Inti's first permission, so the dashboard reads it at once. */
  grantSigned: boolean;
  children: React.ReactNode;
}

/**
 * The chat with the portfolio around it. Wide screens: what the user sets up (wallet, limits,
 * security) on the left, what Inti can buy on the right. Medium screens: everything on the right.
 * Phones: the chat or the portfolio, one at a time.
 */
export function PortfolioLayout({ address, config, client, status, getAccessToken, onManage, onExport, onChanged, view, grantSigned, children }: LayoutProps) {
  const state = useDashboard(address, client, status, getAccessToken, grantSigned);
  const side = "no-scrollbar min-h-0 overflow-y-auto px-4 pb-6";
  const rules = { address, config, client, status, state, onManage, onChanged, getAccessToken };
  const security = { address, config, client, status, onExport, onChanged };
  const money = { address, config, client, status, state, onManage, onChanged, getAccessToken };
  return (
    <>
      <aside className={cn(side, "hidden xl:block xl:w-[360px] xl:shrink-0 xl:pr-0 xl:pl-6")}>
        <div className="flex flex-col gap-4">
          <MoneyPanel {...money} part="wallet" />
          <RulesPanel {...rules} />
          <SecurityPanel {...security} />
        </div>
      </aside>
      {children}
      <aside className={cn(side, view === "chat" ? "hidden" : "flex-1", "lg:block lg:w-[380px] lg:flex-none lg:shrink-0 lg:pr-6 lg:pl-0")}>
        <div className="mx-auto flex max-w-md flex-col gap-4">
          <MoneyPanel {...money} part="wallet" className="xl:hidden" />
          <MoneyPanel {...money} part="assets" />
          <RulesPanel {...rules} className="xl:hidden" />
          <SecurityPanel {...security} className="xl:hidden" />
        </div>
      </aside>
    </>
  );
}

/** What the owner reads after pressing sell on one of the agent's assets. */
function saleMessage(sale: HeldSale, name: string): string {
  switch (sale.status) {
    case "done":
      return `Sold. ${shortAmount(sale.received)} NEAR is in your wallet.`;
    case "pending":
      return "The sale is still settling. Check back in a minute.";
    case "kept":
      return `The sale did not go through. Your ${name} is still with your agent.`;
    case "refused":
      if (sale.code === "no_grant") return "Inti's permission expired. Renew it in Your agent's rules, then sell.";
      if (sale.code === "busy") return "Another order is still running. Try again in a minute.";
      if (sale.code === "no_quote") return "There is no market for this sale right now. Nothing moved. Try again later.";
      if (sale.code === "not_enough") return "Nothing to sell right now.";
      return "The sale was refused. Nothing moved.";
    case "error":
      if (sale.code === "user_limit" || sale.code === "server_limit") return "Too many sales today. Try again tomorrow.";
      if (sale.code === "unauthorized") return "Sign in again, then sell.";
      return "Inti's server could not be reached. Nothing moved.";
  }
}

/**
 * A round button on an asset's card that sells all of it for NEAR. Its label shows on hover and to
 * screen readers; the first press asks, the second sells.
 */
function SellHeldButton({ name, state, blockedBy, onPress }: { name: string; state: "idle" | "confirm" | "selling"; blockedBy: string | null; onPress: () => void }) {
  const label = state === "selling" ? `Selling your ${name}` : state === "confirm" ? `Confirm: sell all your ${name} for NEAR` : (blockedBy ?? `Sell all your ${name} for NEAR (tap twice)`);
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={state === "selling" || (state === "idle" && blockedBy !== null)}
      onClick={onPress}
      className={cn(
        "flex size-9 shrink-0 items-center justify-center rounded-full shadow-sm transition-colors disabled:opacity-40",
        state === "confirm" ? "bg-primary text-primary-foreground" : "bg-neutral-950 text-white hover:bg-neutral-800",
      )}
    >
      {state === "selling" ? <Loader2 className="size-4 animate-spin" /> : state === "confirm" ? <Check className="size-4" /> : <HandCoins className="size-4" />}
    </button>
  );
}

function BalanceRow({ label, near, value, highlight }: { label: string; near: string; value: string; highlight?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className={cn(highlight ? "text-foreground" : "text-muted-foreground")}>{label}</dt>
      <dd className="text-right tabular-nums">
        <span className={cn(highlight && "font-medium")}>{near}</span>
        <span className="ml-2 text-xs text-muted-foreground">{value}</span>
      </dd>
    </div>
  );
}

function Rule({ ok, text }: { ok: boolean; text: string }) {
  return (
    <li className="flex items-center gap-2">
      {ok ? <Check className="size-4 shrink-0 text-primary" /> : <X className="size-4 shrink-0 text-destructive" />}
      <span>{text}</span>
    </li>
  );
}
