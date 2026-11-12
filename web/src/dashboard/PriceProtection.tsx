import { Loader2 } from "lucide-react";
import { useState } from "react";
import type { Signer } from "near-api-js";
import { PRICE_PROTECTION_BPS, type PriceProtectionBps } from "../../../agent/policy/agentPolicy";
import { cn } from "@/lib/utils";
import { setPriceProtection } from "../agent/priceProtection";

const LABELS: Record<PriceProtectionBps, string> = { 100: "Tight", 200: "Normal", 300: "Wide" };

interface Props {
  address: string;
  signer: Signer;
  getAccessToken: () => Promise<string | null>;
  /** The price protection the user signed, in basis points, or null while it is unknown. */
  current: number | null;
  /** When NEAR Intents accepts the next change, or null when it already does. */
  nextChangeAt: string | null;
  /** Reads the dashboard again once the change is live. */
  onSigned: () => void;
}

/**
 * How far from the market Inti may buy: one setting for price orders and buying now. Each change
 * is a new rule the user signs; NEAR Intents applies it, so not even Inti can go past it.
 */
export function PriceProtection({ address, signer, getAccessToken, current, nextChangeAt, onSigned }: Props) {
  const [saved, setSaved] = useState<number | null>(null);
  const [busy, setBusy] = useState<PriceProtectionBps | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Until the dashboard read catches up, show what the user just signed; once it has, its wait applies.
  const shown = saved ?? current;
  const waitUntil = saved === null || saved === current ? nextChangeAt : null;

  const choose = async (bps: PriceProtectionBps) => {
    if (bps === shown) return;
    setBusy(bps);
    setError(null);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error("Your session expired. Sign in again and retry.");
      await setPriceProtection({ accessToken: token, accountId: address, signer, bps });
      setSaved(bps);
      onSigned();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Your price protection could not be changed.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mt-4 border-t pt-4">
      <p className="text-sm font-medium">Price protection</p>
      <p className="mt-1 text-xs text-muted-foreground">
        How far from the market price Inti may buy, for price orders and for buying now. You sign each change.
      </p>
      <div role="radiogroup" aria-label="Price protection" className="mt-2 grid grid-cols-3 gap-1 rounded-full bg-muted p-1">
        {PRICE_PROTECTION_BPS.map((bps) => (
          <button
            key={bps}
            role="radio"
            aria-checked={shown === bps}
            disabled={busy !== null || shown === null}
            onClick={() => void choose(bps)}
            className={cn(
              "flex min-h-11 flex-col items-center justify-center rounded-full px-2 text-sm transition-colors disabled:opacity-60",
              shown === bps ? "bg-background font-semibold shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <span className="flex items-center gap-1">
              {busy === bps && <Loader2 className="size-3.5 animate-spin" />}
              {LABELS[bps]}
            </span>
            <span className="text-xs tabular-nums">{bps / 100}%</span>
          </button>
        ))}
      </div>
      {waitUntil && (
        <p className="mt-2 text-xs text-muted-foreground">
          NEAR Intents waits between rule changes. The next one opens at {new Date(waitUntil).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}.
        </p>
      )}
      {error && <p className="mt-2 break-words text-sm text-destructive">{error}</p>}
    </div>
  );
}
