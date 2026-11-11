import { Clock, Loader2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { GRANT_DAY_CHOICES, issueGrant, type GrantDays } from "../agent/grant";
import type { OwnerSigner } from "../limits/ownerSigner";

interface Props {
  address: string;
  signer: OwnerSigner;
  getAccessToken: () => Promise<string | null>;
  /** Until when Inti may trade (ISO date), or null when it may not. */
  grantUntil: string | null;
}

const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { dateStyle: "medium" });

/**
 * Until when Inti may trade without asking, and a way to sign again for 7, 30 or 90 days. The new
 * permission replaces the earlier one; a shorter one means signing more often.
 */
export function GrantRenewal({ address, signer, getAccessToken, grantUntil }: Props) {
  const [open, setOpen] = useState(false);
  const [days, setDays] = useState<GrantDays>(90);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The dashboard is re-read every few seconds; until it catches up, show the date just signed.
  const [signedUntil, setSignedUntil] = useState<string | null>(null);
  const until = signedUntil ?? grantUntil;

  const renew = async () => {
    setBusy(true);
    setError(null);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error("Your session expired. Sign in again and retry.");
      setSignedUntil(await issueGrant({ accessToken: token, accountId: address, signer, days }));
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Inti's permission could not be renewed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-4 rounded-2xl bg-muted px-3 py-2 text-sm">
      <div className="flex items-center gap-2">
        <Clock className="size-4 shrink-0 text-muted-foreground" />
        {until ? (
          <span className="flex-1">
            Inti may trade for you until <strong>{day(until)}</strong>
          </span>
        ) : (
          <span className="flex-1 text-muted-foreground">Inti has no permission to trade for you yet.</span>
        )}
        {!open && (
          <Button variant="ghost" size="sm" className="-mr-2 rounded-full" onClick={() => setOpen(true)}>
            {until ? "Renew" : "Allow"}
          </Button>
        )}
      </div>
      {open && (
        <div className="mt-2">
          <p className="text-xs text-muted-foreground">For how long? You sign again when it ends. The new permission replaces the current one.</p>
          <div role="radiogroup" aria-label="Permission length" className="mt-2 grid grid-cols-3 gap-1 rounded-full bg-background p-1">
            {GRANT_DAY_CHOICES.map((d) => (
              <button
                key={d}
                role="radio"
                aria-checked={days === d}
                disabled={busy}
                onClick={() => setDays(d)}
                className={cn("min-h-11 rounded-full text-sm transition-colors", days === d ? "bg-primary font-semibold text-primary-foreground" : "text-muted-foreground hover:text-foreground")}
              >
                {d} days
              </button>
            ))}
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <Button variant="outline" className="rounded-full" disabled={busy} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button className="rounded-full" disabled={busy} onClick={() => void renew()}>
              {busy && <Loader2 className="animate-spin" />} Sign
            </Button>
          </div>
        </div>
      )}
      {error && <p className="mt-2 break-words text-sm text-destructive">{error}</p>}
    </div>
  );
}
