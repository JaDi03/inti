import { Copy, ExternalLink, RefreshCw, ShieldCheck, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { fromAtomic, toAtomic } from "../../../agent/policy/units";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { LimitsClient, type SpendLimit, type LimitsStatus } from "./client";
import { useOwnerSigner } from "./ConfirmSigning";
import { PasskeyProtection } from "./PasskeyProtection";
import { loadLimitsConfig, type LimitsConfig } from "./config";
import { UNAVAILABLE } from "./useLimits";

/** Shows at most 4 decimals; display only, never used for math. */
export function display(atomic: bigint, decimals: number): string {
  const [whole, fraction] = fromAtomic(atomic.toString(), decimals).split(".");
  return fraction ? `${whole}.${fraction.slice(0, 4).replace(/0+$/, "") || "0"}` : (whole ?? "0");
}

function parse(value: string, decimals: number): bigint | null {
  try {
    return BigInt(toAtomic(value.trim(), decimals));
  } catch {
    return null;
  }
}

function shortId(id: string): string {
  return id.length > 18 ? `${id.slice(0, 8)}...${id.slice(-6)}` : id;
}

interface Props {
  address: string;
  onClose: () => void;
}

export function SpendingLimitsPanel({ address, onClose }: Props) {
  const setup = useMemo((): { config: LimitsConfig; client: LimitsClient } | { error: string } => {
    try {
      // Limits are changed here after setup; the agent is only needed to install them.
      const config = loadLimitsConfig(null);
      return { config, client: new LimitsClient(config) };
    } catch (e) {
      console.error(e);
      return { error: UNAVAILABLE };
    }
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-background/70 backdrop-blur-sm sm:items-center" role="dialog" aria-modal="true" aria-label="Spending limits">
      <section className="max-h-[92svh] w-full max-w-md overflow-y-auto rounded-t-3xl border bg-card p-5 shadow-xl sm:rounded-3xl">
        <header className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ShieldCheck className="size-5 text-primary" />
            <h2 className="text-lg font-semibold">Spending limits</h2>
          </div>
          <Button variant="ghost" size="icon" aria-label="Close" onClick={onClose}>
            <X />
          </Button>
        </header>
        {"error" in setup ? (
          <p className="text-sm text-destructive">{setup.error}</p>
        ) : (
          <LimitsBody address={address} config={setup.config} client={setup.client} />
        )}
      </section>
    </div>
  );
}

function LimitsBody({ address, config, client }: { address: string; config: LimitsConfig; client: LimitsClient }) {
  const { signer, confirmDialog } = useOwnerSigner(address, config);
  const [status, setStatus] = useState<LimitsStatus | null>(null);
  const [wasm, setWasm] = useState<Uint8Array | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastTx, setLastTx] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setStatus(await client.status(address));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read your account.");
    }
  }, [client, address]);

  useEffect(() => {
    void refresh();
    client.loadWasm().then(setWasm, (e: unknown) => setError(e instanceof Error ? e.message : "Could not load the Spending Limits code."));
  }, [client, refresh]);

  const run = async (label: string, action: () => Promise<string | string[]>) => {
    setBusy(label);
    setError(null);
    try {
      const hashes = await action();
      setLastTx(Array.isArray(hashes) ? (hashes.at(-1) ?? null) : hashes);
      setEditing(false);
      setAdding(false);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The transaction failed.");
    } finally {
      setBusy(null);
    }
  };

  const { symbol, decimals } = config.token;
  const amount = (v: bigint) => `${display(v, decimals)} ${symbol}`;

  let body;
  if (!status || !wasm) {
    body = <p className="text-sm text-muted-foreground">Checking your account...</p>;
  } else if (status.kind !== "installed") {
    const needs = LimitsClient.activationNeeds(wasm.length, DEFAULT_FUND);
    if (status.available < needs) {
      body = <AddFunds address={address} needs={amount(needs)} has={amount(status.available)} onCheck={() => void refresh()} />;
    } else {
      body = (
        <>
          <p className="text-sm text-muted-foreground">
            Your money stays in your account. Inti can only send up to these limits to your agent, one order at a time. You can disconnect Inti at any time.
          </p>
          <LimitForm
            decimals={decimals}
            symbol={symbol}
            withFunding
            submitLabel="Activate Inti"
            busy={busy}
            onSubmit={(limit, fund) => void run("Activating...", () => client.activate(address, signer, wasm, limit, fund))}
          />
          <p className="mt-3 text-xs text-muted-foreground">
            About {amount(LimitsClient.storageCost(wasm.length))} is set aside in your account while Inti is on. It comes back when you turn Inti off. You
            confirm two transactions.
          </p>
        </>
      );
    }
  } else {
    const { limit } = status;
    const pct = limit && limit.perDay > 0n ? Number((status.spentToday * 100n) / limit.perDay) : 0;
    body = (
      <>
        <div className="flex items-center gap-2 text-sm">
          <span className={cn("size-2 rounded-full", status.intiConnected ? "bg-primary" : "bg-muted-foreground")} />
          {status.intiConnected ? "Inti is on" : "Inti is paused: it cannot send anything"}
        </div>

        {limit && (
          <div className="mt-4">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Spent today</span>
              <span>
                {display(status.spentToday, decimals)} of {amount(limit.perDay)}
              </span>
            </div>
            <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${Math.min(pct, 100)}%` }} />
            </div>
          </div>
        )}

        <dl className="mt-4 grid grid-cols-2 gap-y-2 text-sm">
          <dt className="text-muted-foreground">Max per order</dt>
          <dd className="text-right">{limit ? amount(limit.perOrder) : "Not set"}</dd>
          <dt className="text-muted-foreground">Available for orders</dt>
          <dd className="text-right">{amount(status.spendable)}</dd>
          <dt className="text-muted-foreground">Sends only to</dt>
          <dd className="text-right font-mono text-xs leading-5" title={status.agent}>
            your agent ({shortId(status.agent)})
          </dd>
        </dl>

        {editing ? (
          <LimitForm
            decimals={decimals}
            symbol={symbol}
            initial={limit ?? undefined}
            submitLabel="Save limits"
            busy={busy}
            onSubmit={(next) => void run("Saving...", () => client.setLimit(address, signer, next))}
            onCancel={() => setEditing(false)}
          />
        ) : adding ? (
          <AddForOrdersForm
            decimals={decimals}
            symbol={symbol}
            max={LimitsClient.maxForOrders(status.available)}
            busy={busy}
            onSubmit={(value) => void run("Adding NEAR for orders...", () => client.addForOrders(address, signer, value))}
            onCancel={() => setAdding(false)}
          />
        ) : (
          <div className="mt-5 flex flex-wrap gap-2">
            <Button disabled={busy !== null} onClick={() => setAdding(true)}>
              Add NEAR for orders
            </Button>
            <Button variant="outline" disabled={busy !== null} onClick={() => setEditing(true)}>
              Edit limits
            </Button>
            {status.intiConnected ? (
              <Button variant="destructive" disabled={busy !== null} onClick={() => void run("Pausing...", () => client.disconnectInti(address, signer))}>
                Pause Inti
              </Button>
            ) : (
              <Button disabled={busy !== null} onClick={() => void run("Resuming...", () => client.reconnectInti(address, signer))}>
                Resume Inti
              </Button>
            )}
            <Button variant="ghost" size="icon" aria-label="Refresh" disabled={busy !== null} onClick={() => void refresh()}>
              <RefreshCw />
            </Button>
          </div>
        )}
        <div className="mt-5">
          <PasskeyProtection />
        </div>

        {!editing && !adding && (
          <div className="mt-5 rounded-xl border p-3 text-sm">
            <p className="font-medium">Turn off Inti</p>
            <p className="mt-1 text-muted-foreground">
              Inti stops working and your whole balance is back to normal, including the NEAR set aside for Inti. You can turn Inti on again later.
            </p>
            <Button
              className="mt-2"
              variant="outline"
              disabled={busy !== null}
              onClick={() =>
                void run("Turning off Inti: confirm once...", async () => {
                  const plan = client.releasePlan(address, status.spendable, status.intiConnected);
                  await signer.approveAll(plan);
                  return client.send(address, signer, plan);
                })
              }
            >
              Turn off Inti
            </Button>
          </div>
        )}
      </>
    );
  }

  return (
    <div>
      {body}
      {confirmDialog}
      {busy && <p className="mt-3 text-sm text-muted-foreground">{busy}</p>}
      {error && <p className="mt-3 break-words text-sm text-destructive">{error}</p>}
      {lastTx && (
        <a className="mt-3 inline-flex items-center gap-1 text-sm text-primary underline-offset-4 hover:underline" href={config.explorerTxUrl(lastTx)} target="_blank" rel="noreferrer">
          View last transaction <ExternalLink className="size-3.5" />
        </a>
      )}
    </div>
  );
}

export const DEFAULT_FUND = 10n ** 23n; // 0.1 NEAR

function AddFunds({ address, needs, has, onCheck }: { address: string; needs: string; has: string; onCheck: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="text-sm">
      <p>
        To activate Inti, your account needs at least <strong>{needs}</strong>. It has {has}.
      </p>
      <p className="mt-3 text-muted-foreground">Send funds to your account:</p>
      <div className="mt-1.5 flex items-center gap-2 rounded-xl bg-muted px-3 py-2">
        <code className="min-w-0 flex-1 truncate text-xs">{address}</code>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Copy address"
          onClick={() => void navigator.clipboard.writeText(address).then(() => setCopied(true), () => undefined)}
        >
          <Copy />
        </Button>
      </div>
      {copied && <p className="mt-1 text-xs text-muted-foreground">Copied</p>}
      <Button className="mt-4" variant="outline" onClick={onCheck}>
        I sent the funds
      </Button>
    </div>
  );
}

interface LimitFormProps {
  decimals: number;
  symbol: string;
  initial?: SpendLimit;
  withFunding?: boolean;
  submitLabel: string;
  busy: string | null;
  onSubmit: (limit: SpendLimit, fund: bigint) => void;
  onCancel?: () => void;
}

export function LimitForm({ decimals, symbol, initial, withFunding, submitLabel, busy, onSubmit, onCancel }: LimitFormProps) {
  const [perOrder, setPerOrder] = useState(initial ? fromAtomic(initial.perOrder.toString(), decimals) : "0.02");
  const [perDay, setPerDay] = useState(initial ? fromAtomic(initial.perDay.toString(), decimals) : "0.05");
  const [fund, setFund] = useState(fromAtomic(DEFAULT_FUND.toString(), decimals));

  const order = parse(perOrder, decimals);
  const day = parse(perDay, decimals);
  const funding = withFunding ? parse(fund, decimals) : 0n;
  const problem =
    order === null || day === null
      ? "Enter amounts greater than zero."
      : order > day
        ? "The max per order cannot be higher than the max per day."
        : withFunding && funding === null
          ? "Enter how much to make available."
          : null;

  return (
    <form
      className="mt-4 flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (problem || order === null || day === null || funding === null) return;
        onSubmit({ perOrder: order, perDay: day }, funding);
      }}
    >
      <AmountField label="Max per order" symbol={symbol} value={perOrder} onChange={setPerOrder} />
      <AmountField label="Max per day" symbol={symbol} value={perDay} onChange={setPerDay} />
      {withFunding && <AmountField label="Make available for orders" symbol={symbol} value={fund} onChange={setFund} />}
      {problem && <p className="text-sm text-destructive">{problem}</p>}
      <div className="flex gap-2">
        <Button type="submit" size="lg" className="rounded-full px-5" disabled={problem !== null || busy !== null}>
          {submitLabel}
        </Button>
        {onCancel && (
          <Button type="button" variant="ghost" size="lg" onClick={onCancel} disabled={busy !== null}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}

interface AddForOrdersProps {
  decimals: number;
  symbol: string;
  /** Most the user can add, already leaving room for network fees. */
  max: bigint;
  busy: string | null;
  onSubmit: (amount: bigint) => void;
  onCancel: () => void;
}

/** Moves more of the user's NEAR into the balance orders are funded from; it never leaves the account. */
export function AddForOrdersForm({ decimals, symbol, max, busy, onSubmit, onCancel }: AddForOrdersProps) {
  const [value, setValue] = useState(fromAtomic((DEFAULT_FUND < max ? DEFAULT_FUND : max).toString(), decimals));
  const parsed = parse(value, decimals);
  const problem =
    max === 0n
      ? `Your account has no free ${symbol} to add. Send some to your account first.`
      : parsed === null || parsed === 0n
        ? "Enter an amount greater than zero."
        : parsed > max
          ? `You can add at most ${display(max, decimals)} ${symbol}. A little stays free for network fees.`
          : null;

  return (
    <form
      className="mt-4 flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (problem || parsed === null) return;
        onSubmit(parsed);
      }}
    >
      <p className="text-sm text-muted-foreground">
        Inti pays for your orders from this balance. It stays in your account. You can add up to {display(max, decimals)} {symbol}.
      </p>
      <AmountField label="Add for orders" symbol={symbol} value={value} onChange={setValue} />
      {problem && <p className="text-sm text-destructive">{problem}</p>}
      <div className="flex gap-2">
        <Button type="submit" size="lg" className="rounded-full px-5" disabled={problem !== null || busy !== null}>
          Add NEAR
        </Button>
        <Button type="button" variant="ghost" size="lg" onClick={onCancel} disabled={busy !== null}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function AmountField({ label, symbol, value, onChange }: { label: string; symbol: string; value: string; onChange: (v: string) => void }) {
  return (
    // Label left, value right, in one field (card style: "Format Style · Interview Mode").
    <label className="flex h-12 items-center gap-3 rounded-xl border border-border bg-background/60 px-4 text-sm focus-within:ring-2 focus-within:ring-ring/40">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <input
        className="min-w-0 flex-1 bg-transparent text-right text-base font-medium outline-none"
        inputMode="decimal"
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <span className="shrink-0 text-muted-foreground">{symbol}</span>
    </label>
  );
}
