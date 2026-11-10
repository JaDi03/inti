import { Check, Copy, ExternalLink, Loader2, ShieldCheck, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { LimitsClient, type LimitsStatus } from "./client";
import { useOwnerSigner } from "./ConfirmSigning";
import { PasskeyProtection, useHasPasskey } from "./PasskeyProtection";
import { DEFAULT_FUND, display, LimitForm } from "./SpendingLimitsPanel";
import type { LimitsSetup } from "./useLimits";

interface Props {
  address: string;
  setup: LimitsSetup;
  status: LimitsStatus | null;
  refresh: () => Promise<void>;
  /** Hides the card after the user has seen the "ready" summary. */
  onDone: () => void;
  /** True while activation transactions are being signed and sent (the mascot shows it). */
  onWorking?: (working: boolean) => void;
}

/**
 * First-run activation, inline on the home screen (not behind the shield icon):
 * 1. add a passkey, 2. add funds (the app notices them by itself), 3. set spending limits and
 * sign, 4. see where the money sits.
 */
export function ActivationCard({ address, setup, status, refresh, onDone, onWorking }: Props) {
  if (setup.kind === "error") {
    return (
      <CardFrame title="Spending Limits is unavailable" subtitle={setup.message}>
        {null}
      </CardFrame>
    );
  }
  return <ActivationSteps address={address} client={setup.client} status={status} refresh={refresh} onDone={onDone} onWorking={onWorking} />;
}

interface StepsProps {
  address: string;
  client: LimitsClient;
  status: LimitsStatus | null;
  refresh: () => Promise<void>;
  onDone: () => void;
  onWorking?: (working: boolean) => void;
}

function ActivationSteps({ address, client, status, refresh, onDone, onWorking }: StepsProps) {
  const { config } = client;
  const { symbol, decimals } = config.token;
  const amount = (v: bigint) => `${display(v, decimals)} ${symbol}`;
  const { signer, confirmDialog } = useOwnerSigner(address, config);
  const hasPasskey = useHasPasskey();
  const [wasm, setWasm] = useState<Uint8Array | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastTx, setLastTx] = useState<string | null>(null);

  useEffect(() => {
    client.loadWasm().then(setWasm, (e: unknown) => setError(e instanceof Error ? e.message : "Could not load the Spending Limits code."));
  }, [client]);

  if (!status || !wasm) {
    return (
      <CardFrame title="Give Inti money, not your keys" subtitle="Checking your account...">
        <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" />
      </CardFrame>
    );
  }

  const needs = LimitsClient.activationNeeds(wasm.length, DEFAULT_FUND);
  const funded = status.kind === "installed" || status.available >= needs;
  const active = status.kind === "installed";

  const activate = async (limit: Parameters<LimitsClient["activate"]>[3], fund: bigint) => {
    setBusy("Activating Inti: confirm the two signatures...");
    setError(null);
    onWorking?.(true);
    try {
      const hashes = await client.activate(address, signer, wasm, limit, fund);
      setLastTx(hashes.at(-1) ?? null);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Activation failed.");
    } finally {
      setBusy(null);
      onWorking?.(false);
    }
  };

  return (
    <CardFrame
      title={active ? "Inti is ready" : "Give Inti money, not your keys"}
      subtitle={
        active
          ? "Your money stays in your account. Inti can only fund your own agent, within your limits."
          : "Set up in 3 steps. Your money never leaves your account: Inti only gets a key that funds your own agent, within the limits you sign."
      }
      onClose={active ? onDone : undefined}
    >
      {!active && (
        <>
          <Step n={1} title="Protect your account with a passkey" done={hasPasskey}>
            <PasskeyProtection />
          </Step>

          <Step n={2} title="Add funds" done={funded} disabled={!hasPasskey}>
            {hasPasskey &&
              (funded ? (
                <p className="text-sm text-muted-foreground">Your account has {amount(status.available)}.</p>
              ) : (
                <AddFundsStep address={address} needs={amount(needs)} has={amount(status.available)} />
              ))}
          </Step>

          <Step n={3} title="Set your spending limits" done={false} disabled={!funded || !hasPasskey}>
            {funded && hasPasskey && (
              <>
                <KeyLimits />
                <LimitForm decimals={decimals} symbol={symbol} withFunding submitLabel="Activate Inti" busy={busy} onSubmit={(limit, fund) => void activate(limit, fund)} />
                <p className="mt-2 text-xs text-muted-foreground">
                  About {amount(LimitsClient.storageCost(wasm.length))} stays locked in your account while Spending Limits is installed (network storage).
                </p>
              </>
            )}
          </Step>
        </>
      )}

      {active && status.kind === "installed" && (
        <>
          <p className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">Where your money is</p>
          <div className="flex flex-col gap-2">
            <Row label="In your account" value={amount(status.available)} />
            <Row label="Available for orders" value={amount(status.spendable)} />
            <Row label="Sent to your agent today" value={amount(status.spentToday)} />
            {status.limit && <Row label="Your limits" value={`${amount(status.limit.perOrder)} per order · ${amount(status.limit.perDay)} per day`} />}
          </div>
          <div className="mt-5 flex justify-end">
            <Button size="lg" className="rounded-xl px-5" onClick={onDone}>
              Start chatting
            </Button>
          </div>
        </>
      )}

      {confirmDialog}
      {busy && (
        <p className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> {busy}
        </p>
      )}
      {error && <p className="mt-3 break-words text-sm text-destructive">{error}</p>}
      {lastTx && (
        <a className="mt-3 inline-flex items-center gap-1 text-sm text-primary underline-offset-4 hover:underline" href={config.explorerTxUrl(lastTx)} target="_blank" rel="noreferrer">
          View transaction <ExternalLink className="size-3.5" />
        </a>
      )}
    </CardFrame>
  );
}

/** Card style from the design reference: icon tile, title and subtitle, close button, roomy padding. */
function CardFrame({ title, subtitle, onClose, children }: { title: string; subtitle: string; onClose?: () => void; children: ReactNode }) {
  return (
    <section className="w-full max-w-[560px] rounded-3xl border border-border bg-card p-5 text-left shadow-sm sm:p-6">
      <header className="mb-5 flex items-start gap-4">
        <span className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-muted">
          <ShieldCheck className="size-6 text-primary" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold leading-tight">{title}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
        </div>
        {onClose && (
          <Button variant="ghost" size="icon" aria-label="Close" onClick={onClose}>
            <X />
          </Button>
        )}
      </header>
      {children}
    </section>
  );
}

function Step({ n, title, done, disabled, children }: { n: number; title: string; done: boolean; disabled?: boolean; children: ReactNode }) {
  return (
    <div className={cn("mb-3 rounded-2xl border border-border bg-background/60 p-4", disabled && "opacity-50")}>
      <div className="flex items-center gap-3">
        <span
          className={cn(
            "flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
            done ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
          )}
        >
          {done ? <Check className="size-3.5" /> : n}
        </span>
        <h3 className="text-sm font-semibold">{title}</h3>
      </div>
      {children && <div className="mt-3 pl-9">{children}</div>}
    </div>
  );
}

function AddFundsStep({ address, needs, has }: { address: string; needs: string; has: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="text-sm">
      <p className="text-muted-foreground">
        Your account needs <strong className="text-foreground">{needs}</strong>. It has {has}.
      </p>
      <div className="mt-3 flex items-center gap-2 rounded-xl border border-border bg-card px-3 py-2">
        <code className="min-w-0 flex-1 truncate text-xs">{address}</code>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Copy address"
          onClick={() => void navigator.clipboard.writeText(address).then(() => setCopied(true), () => undefined)}
        >
          {copied ? <Check /> : <Copy />}
        </Button>
      </div>
      <p className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" /> Waiting for funds. This step completes by itself.
      </p>
    </div>
  );
}

/** What Inti's key can and cannot do (the security track asks to explain the key's limits). */
function KeyLimits() {
  return (
    <ul className="mb-1 grid gap-1.5 text-sm">
      <li className="flex gap-2">
        <Check className="mt-0.5 size-4 shrink-0 text-primary" /> Fund your own agent, one order at a time, up to your limits
      </li>
      <li className="flex gap-2">
        <X className="mt-0.5 size-4 shrink-0 text-muted-foreground" /> Send money anywhere else
      </li>
      <li className="flex gap-2">
        <X className="mt-0.5 size-4 shrink-0 text-muted-foreground" /> Change your limits or move your funds
      </li>
    </ul>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex h-12 items-center justify-between gap-3 rounded-xl border border-border bg-background/60 px-4 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium">{value}</span>
    </div>
  );
}
