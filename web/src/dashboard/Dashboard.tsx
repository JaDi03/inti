import { Check, Clock, ExternalLink, Loader2, Lock, Plus, RefreshCw, ShieldCheck, Sparkles, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ASSET_KEYS, ASSETS, type AssetKey } from "../../../agent/policy/assets";
import { fromAtomic } from "../../../agent/policy/units";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { DECIMALS } from "../assets/AssetsPanel";
import type { LimitsClient, LimitsStatus } from "../limits/client";
import { useOwnerSigner } from "../limits/ConfirmSigning";
import type { LimitsConfig } from "../limits/config";
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
};

const NEAR_DECIMALS = 24;

/** Dollar value for display only; amounts stay exact in atomic units everywhere else. */
function usd(amount: string, price: number | null | undefined): number | null {
  const n = Number(amount);
  return price == null || !Number.isFinite(n) ? null : n * price;
}

const money = (v: number | null) => (v === null ? "--" : v.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }));

interface Props {
  address: string;
  config: LimitsConfig;
  client: LimitsClient;
  status: Installed;
  getAccessToken: () => Promise<string | null>;
  /** Opens the Spending limits window (edit limits, add NEAR, pause or turn off Inti). */
  onManage: () => void;
  className?: string;
}

/** The user's money and the rules around it, always in view next to the chat. */
export function Dashboard({ address, config, client, status, getAccessToken, onManage, className }: Props) {
  const { signer, confirmDialog } = useOwnerSigner(address, config);
  const [data, setData] = useState<DashboardData | null>(null);
  const [assets, setAssets] = useState<AssetRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<AssetKey | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastTx, setLastTx] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const token = await getAccessToken();
      const [server, rows] = await Promise.all([token ? fetchDashboard(token) : Promise.resolve(null), client.assets(address).catch(() => null)]);
      setData(server);
      setAssets(rows);
    } finally {
      setLoading(false);
    }
  }, [address, client, getAccessToken]);

  useEffect(() => {
    void load();
  }, [load, status]);

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
  const nearText = (atomic: bigint) => display(atomic, NEAR_DECIMALS);
  const free = fromAtomic(status.available.toString(), NEAR_DECIMALS);
  const forOrders = fromAtomic(status.spendable.toString(), NEAR_DECIMALS);
  const setAside = fromAtomic(status.setAside.toString(), NEAR_DECIMALS);
  const assetValues = (assets ?? []).map((r) => usd(fromAtomic(r.balance.toString(), DECIMALS[r.key]), data?.prices[r.key]) ?? 0);
  const nearValues = [free, forOrders, setAside].map((v) => usd(v, nearPrice));
  const total = nearValues.some((v) => v === null) ? null : [...nearValues, ...assetValues].reduce<number>((a, b) => a + (b ?? 0), 0);

  return (
    <div className={cn("flex flex-col gap-4", className)}>
      {/* Wallet */}
      <section className="rounded-3xl border bg-card p-5">
        <div className="flex items-start justify-between">
          <p className="text-sm text-muted-foreground">Your wallet</p>
          <Button variant="ghost" size="icon-sm" aria-label="Refresh" disabled={loading} onClick={() => void load()}>
            <RefreshCw className={cn(loading && "animate-spin")} />
          </Button>
        </div>
        <p className="mt-1 text-4xl font-semibold tracking-tight tabular-nums">{money(total)}</p>
        <p className="text-xs text-muted-foreground">Everything below is in your own account.</p>
        <dl className="mt-4 flex flex-col gap-2 text-sm">
          <BalanceRow label="Free to use" near={nearText(status.available)} value={nearValues[0] ?? null} />
          <BalanceRow label="For orders" near={nearText(status.spendable)} value={nearValues[1] ?? null} highlight />
          <BalanceRow
            label="Set aside for Inti"
            near={nearText(status.setAside)}
            value={nearValues[2] ?? null}
            icon={<Lock className="size-3.5" />}
            hint="Kept by the network while Inti's rules live on your account. It comes back when you turn Inti off."
          />
        </dl>
        <Button className="mt-4 w-full rounded-full" onClick={onManage}>
          <Plus /> Add NEAR for orders
        </Button>
      </section>

      {/* Assets */}
      <section>
        <h2 className="mb-2 px-1 text-sm font-medium text-muted-foreground">What Inti can buy for you</h2>
        <ul className="grid grid-cols-2 gap-3">
          {ASSET_KEYS.map((key) => {
            const a = ASSETS[key];
            const row = assets?.find((r) => r.key === key);
            const amount = row ? fromAtomic(row.balance.toString(), DECIMALS[key]) : null;
            const price = data?.prices[key];
            return (
              <li key={key} className={cn("flex min-h-36 flex-col justify-between rounded-3xl p-4 text-neutral-950", TILE[key])}>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold uppercase tracking-wide">{a.name}</p>
                    <p className="text-xs opacity-70">{a.kind === "real-world" ? "Real-world asset" : "Crypto"} · {a.symbol}</p>
                  </div>
                  {row?.enabled && <Check className="size-4 shrink-0" aria-label="Enabled" />}
                </div>
                <div>
                  {row?.enabled ? (
                    <>
                      <p className="text-2xl font-semibold tabular-nums">{money(amount === null ? null : usd(amount, price))}</p>
                      <p className="truncate text-xs tabular-nums opacity-70" title={amount ?? ""}>
                        {amount ?? "--"} {a.symbol}
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
        <p className="mt-2 px-1 text-xs text-muted-foreground">Enabling an asset costs a one-time 0.00125 NEAR, paid to its token, so your wallet can receive it.</p>
      </section>

      {/* Spending Limits, on the user's account */}
      <section className="rounded-3xl border bg-card p-5">
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 font-medium">
            <ShieldCheck className="size-4 text-primary" /> Spending limits
          </h2>
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className={cn("size-2 rounded-full", status.intiConnected ? "bg-primary" : "bg-muted-foreground")} />
            {status.intiConnected ? "Inti is on" : "Inti is paused"}
          </span>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">A contract on your own account. Inti can only send what these limits allow, and only to your agent.</p>
        {status.limit ? (
          <>
            <div className="mt-4 flex justify-between text-sm">
              <span className="text-muted-foreground">Used in the last 24 h</span>
              <span className="tabular-nums">
                {nearText(status.spentToday)} of {nearText(status.limit.perDay)} NEAR
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
              <span className="tabular-nums">{nearText(status.limit.perOrder)} NEAR</span>
            </div>
          </>
        ) : (
          <p className="mt-3 text-sm">No limit set yet.</p>
        )}
        <Button variant="outline" className="mt-4 w-full rounded-full" onClick={onManage}>
          Manage limits
        </Button>
      </section>

      {/* The agent's own rules, signed by the user */}
      <section className="rounded-3xl border bg-card p-5">
        <h2 className="flex items-center gap-2 font-medium">
          <Sparkles className="size-4 text-primary" /> Your agent&apos;s rules
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">Signed by you on NEAR Intents. Nobody can change them without your signature, not even Inti.</p>
        {data?.agent?.policy ? (
          <ul className="mt-3 flex flex-col gap-2 text-sm">
            <Rule ok={data.agent.policy.sendsOnlyToOwner} text="Sends only to you" />
            <Rule ok={data.agent.policy.canBuyNow} text="Can buy now" />
            <Rule
              ok={data.agent.policy.canPlaceLimitOrders}
              text={`Can place price orders${data.agent.policy.maxPriceGapPercent ? `, at most ${data.agent.policy.maxPriceGapPercent}% from the market` : ""}`}
            />
            {data.agent.policy.maxActionsPerHour !== null && <Rule ok text={`At most ${data.agent.policy.maxActionsPerHour} actions per hour`} />}
            {data.agent.policy.frozen && <Rule ok={false} text="Frozen: it can do nothing" />}
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
        {data?.agent?.orders && data.agent.orders.length > 0 ? (
          <ul className="mt-2 flex flex-col gap-2">
            {data.agent.orders.map((o, i) => (
              <li key={`${o.deadline}-${i}`} className="flex items-center justify-between gap-2 rounded-2xl border px-3 py-2 text-sm">
                <span>
                  {o.amount ?? "--"} {o.asset ? ASSETS[o.asset].symbol : "?"} at {o.priceUsd ? `$${o.priceUsd}` : `${o.priceNear} NEAR`}
                </span>
                <span className="text-xs text-muted-foreground">until {new Date(o.deadline).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-sm text-muted-foreground">None right now.</p>
        )}
      </section>

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

function BalanceRow({ label, near, value, highlight, icon, hint }: { label: string; near: string; value: number | null; highlight?: boolean; icon?: React.ReactNode; hint?: string }) {
  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <dt className={cn("flex items-center gap-1.5", highlight ? "text-foreground" : "text-muted-foreground")}>
          {icon}
          {label}
        </dt>
        <dd className="text-right tabular-nums">
          <span className={cn(highlight && "font-medium")}>{near} NEAR</span>
          <span className="ml-2 text-xs text-muted-foreground">{money(value)}</span>
        </dd>
      </div>
      {hint && <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{hint}</p>}
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
