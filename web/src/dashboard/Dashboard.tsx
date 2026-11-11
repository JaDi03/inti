import { Check, ChevronDown, Clock, ExternalLink, Eye, EyeOff, KeyRound, Loader2, Lock, Pause, Play, Plus, Power, RefreshCw, ShieldCheck, Sparkles, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ASSET_KEYS, ASSETS, type AssetKey } from "../../../agent/policy/assets";
import { fromAtomic } from "../../../agent/policy/units";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { DECIMALS } from "../assets/AssetsPanel";
import type { LimitsClient, LimitsStatus } from "../limits/client";
import { useOwnerSigner } from "../limits/ConfirmSigning";
import type { LimitsConfig } from "../limits/config";
import { PasskeyProtection } from "../limits/PasskeyProtection";
import { display } from "../limits/SpendingLimitsPanel";
import { fetchDashboard, type DashboardData } from "./dashboardClient";

type Installed = Extract<LimitsStatus, { kind: "installed" }>;
type AssetRow = { key: AssetKey; enabled: boolean; balance: bigint };

/** One color per asset, dark text on a light tile so it reads in both themes. */
const TILE: Record<AssetKey, string> = {
  gold: "bg-amber-300",
  euro: "bg-sky-300",
  pound: "bg-violet-300",
  bitcoin: "bg-orange-300",
  ethereum: "bg-indigo-200",
  solana: "bg-fuchsia-300",
};

/** The areas of the dashboard, by what each asset is. */
const GROUPS: { title: string; keys: AssetKey[] }[] = [
  { title: "Real-world assets", keys: ASSET_KEYS.filter((k) => ASSETS[k].kind === "real-world") },
  { title: "Currencies", keys: ASSET_KEYS.filter((k) => ASSETS[k].kind === "currency") },
  { title: "Crypto", keys: ASSET_KEYS.filter((k) => ASSETS[k].kind === "crypto") },
];

const NEAR_DECIMALS = 24;
const HIDDEN = "••••";

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
  load: () => Promise<void>;
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
function useDashboard(address: string, client: LimitsClient, status: Installed, getAccessToken: () => Promise<string | null>): DashboardState {
  const [data, setData] = useState<DashboardData | null>(null);
  const [assets, setAssets] = useState<AssetRow[] | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const token = await getAccessToken();
      const [server, rows] = await Promise.all([token ? fetchDashboard(token) : Promise.resolve(null), client.assets(address).catch(() => null)]);
      // A failed read keeps what is already on screen instead of blanking it.
      if (server) setData(server);
      if (rows) setAssets(rows);
    } finally {
      setLoading(false);
    }
  }, [address, client, getAccessToken]);

  // Read again only when the account's balances or limits really changed, not on every re-render.
  const balances = `${status.available}:${status.spendable}:${status.spentToday}:${status.intiConnected}`;
  useEffect(() => {
    void load();
  }, [load, balances]);

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
  /** The wallet card, the asset areas, or both. */
  part: "wallet" | "assets" | "both";
  className?: string;
}

/** The user's money: the wallet and the assets Inti can buy, each enabled from its own tile. */
export function MoneyPanel({ address, config, client, status, state, onManage, part, className }: MoneyProps) {
  const { signer, confirmDialog } = useOwnerSigner(address, config);
  const { data, assets, loading, load } = state;
  const { hidden, toggleHidden } = useHideAmounts("money");
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

  const nearPrice = data?.prices.near ?? null;
  const inWallet = usd(fromAtomic(status.available.toString(), NEAR_DECIMALS), nearPrice);
  const forOrders = usd(fromAtomic(status.spendable.toString(), NEAR_DECIMALS), nearPrice);
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
            <Button variant="ghost" size="icon-sm" aria-label="Refresh" disabled={loading} onClick={() => void load()}>
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
        </dl>
        <Button className="mt-4 w-full rounded-full" onClick={onManage}>
          <Plus /> Add NEAR for orders
        </Button>
      </section>
      )}

      {part !== "wallet" && GROUPS.map((group) => (
      <section key={group.title}>
        <h2 className="mb-2.5 px-1 text-lg font-semibold tracking-tight text-foreground">{group.title}</h2>
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
                    <img src={`/tokens/${key}.png`} alt="" width={36} height={36} className={cn("size-9 shrink-0 rounded-full bg-white object-cover ring-2 ring-white/70", key === "gold" && "p-1")} />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold uppercase tracking-wide">{a.name}</p>
                      <p className="text-xs opacity-70">{a.symbol}</p>
                    </div>
                  </div>
                  {row?.enabled && (
                    <span className="flex shrink-0 items-center gap-1 rounded-full bg-neutral-950/10 px-2 py-0.5 text-[11px] font-semibold">
                      <Check className="size-3" /> Enabled
                    </span>
                  )}
                </div>
                <div>
                  {row?.enabled ? (
                    <>
                      <p className="text-2xl font-semibold tabular-nums">{show(money(amount === null ? null : usd(amount, price)))}</p>
                      <p className="truncate text-xs tabular-nums opacity-70" title={hidden ? "" : (amount ?? "")}>
                        {show(`${amount ?? "--"} ${a.symbol}`)}
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
                  <p className="mt-1 text-[11px] tabular-nums opacity-70">{price == null ? "No price right now" : `1 ${a.symbol} = ${money(price)}`}</p>
                </div>
              </li>
            );
          })}
        </ul>
      </section>
      ))}
      {part !== "wallet" && (
        <p className="-mt-2 px-1 text-xs text-muted-foreground">Enabling an asset costs a one-time 0.00125 NEAR, paid to its token, so your wallet can receive it.</p>
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
  className?: string;
}

/** The rules around the money: Spending Limits on the user's account and the agent's signed rules. */
export function RulesPanel({ address, config, client, status, state, onManage, onChanged, className }: RulesProps) {
  const { signer, confirmDialog } = useOwnerSigner(address, config);
  const { data, loading } = state;
  const { hidden, toggleHidden } = useHideAmounts("rules");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const policy = data?.agent?.policy;
  const orders = data?.agent?.orders;
  const near = (atomic: bigint) => (hidden ? HIDDEN : nearText(atomic));

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
          <>
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className={cn("size-2 rounded-full", status.intiConnected ? "bg-primary" : "bg-muted-foreground")} />
              {status.intiConnected ? "Inti is on" : "Inti is paused"}
            </span>
            <Button variant="ghost" size="icon-sm" aria-label={hidden ? "Show amounts" : "Hide amounts"} onClick={toggleHidden}>
              {hidden ? <EyeOff /> : <Eye />}
            </Button>
          </>
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

      <FoldCard id="agent" icon={<Sparkles className="size-4 text-primary" />} title="Your agent's rules">
        <p className="mt-1 text-xs text-muted-foreground">Signed by you on NEAR Intents. Nobody can change them without your signature, not even Inti.</p>
        {policy ? (
          <ul className="mt-3 flex flex-col gap-2 text-sm">
            <Rule ok={policy.sendsOnlyToOwner} text="Sends only to you" />
            <Rule ok={policy.canBuyNow} text="Can buy now" />
            <Rule ok={policy.canPlaceLimitOrders} text={`Can place price orders${policy.maxPriceGapPercent ? `, at most ${policy.maxPriceGapPercent}% from the market` : ""}`} />
            {policy.maxActionsPerHour !== null && <Rule ok text={`At most ${policy.maxActionsPerHour} actions per hour`} />}
            {policy.frozen && <Rule ok={false} text="Frozen: it can do nothing" />}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-muted-foreground">{loading ? "Reading your agent..." : "Your agent's rules are not available right now."}</p>
        )}
        <div className="mt-4 flex items-center gap-2 rounded-2xl bg-muted px-3 py-2 text-sm">
          <Clock className="size-4 shrink-0 text-muted-foreground" />
          {data?.agent?.grantUntil ? (
            <span>
              Inti may trade for you until <strong>{new Date(data.agent.grantUntil).toLocaleDateString("en-US", { dateStyle: "medium" })}</strong>
            </span>
          ) : (
            <span className="text-muted-foreground">Inti has no permission to trade for you yet.</span>
          )}
        </div>
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
    </div>
  );
}

/** A card the user can fold to its title; it remembers how the user left it. */
function FoldCard({ id, icon, title, extra, className, children }: { id: string; icon: React.ReactNode; title: string; extra?: React.ReactNode; className?: string; children: React.ReactNode }) {
  const [open, toggle] = useRememberedSwitch(`inti-open-${id}`, true);
  return (
    <section className={cn("rounded-3xl border bg-card p-5", className)}>
      <div className="flex items-center gap-1">
        <button className="-my-1 flex min-w-0 flex-1 items-center gap-2 py-1 text-left font-medium" aria-expanded={open} onClick={toggle}>
          {icon}
          <h2 className="truncate">{title}</h2>
          <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground transition-transform", !open && "-rotate-90")} />
        </button>
        {extra && <div className="-mr-2 flex shrink-0 items-center gap-1">{extra}</div>}
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
  children: React.ReactNode;
}

/**
 * The chat with the portfolio around it. Wide screens: what the user sets up (wallet, limits,
 * security) on the left, what Inti can buy on the right. Medium screens: everything on the right.
 * Phones: the chat or the portfolio, one at a time.
 */
export function PortfolioLayout({ address, config, client, status, getAccessToken, onManage, onExport, onChanged, view, children }: LayoutProps) {
  const state = useDashboard(address, client, status, getAccessToken);
  const side = "no-scrollbar min-h-0 overflow-y-auto px-4 pb-6";
  const rules = { address, config, client, status, state, onManage, onChanged };
  const security = { address, config, client, status, onExport, onChanged };
  const money = { address, config, client, status, state, onManage };
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
