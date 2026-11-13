import { Check, Loader2, ShieldCheck, ShieldAlert, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { CHECK_TEXT, fetchVerification, type ModelVerification } from "./verifyClient";

function ago(iso: string, now: number): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  return minutes < 1 ? "just now" : minutes === 1 ? "1 min ago" : `${minutes} min ago`;
}

/**
 * The badge by the logo that says whether the chat's model runs in verified private hardware.
 * It checks once when the app opens; the card it opens can check again.
 */
export function VerifiedBadge({ getAccessToken }: { getAccessToken: () => Promise<string | null> }) {
  const [result, setResult] = useState<ModelVerification | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const check = useCallback(async () => {
    setChecking(true);
    setError(null);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error("Sign in again to run the check.");
      setResult(await fetchVerification(token));
    } catch (e) {
      setError(e instanceof Error ? e.message : "The check could not run right now.");
    } finally {
      setChecking(false);
      setNow(Date.now());
    }
  }, [getAccessToken]);

  useEffect(() => {
    void check();
  }, [check]);

  const verified = result?.ok === true;
  const label = checking && !result ? "Checking private AI…" : verified ? "Private AI · verified" : "Private AI · not verified";
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setNow(Date.now());
          setOpen(true);
        }}
        className={cn(
          "flex h-8 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium sm:px-3",
          verified ? "bg-primary/10 text-primary" : checking && !result ? "bg-muted text-muted-foreground" : "bg-destructive/10 text-destructive",
        )}
      >
        {checking && !result ? <Loader2 className="size-3.5 animate-spin" /> : verified ? <ShieldCheck className="size-3.5" /> : <ShieldAlert className="size-3.5" />}
        {/* On a phone the header is narrow: the shield alone, with its words for screen readers. */}
        <span className="hidden sm:inline">{label}</span>
        <span className="sr-only sm:hidden">{label}</span>
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-background/70 backdrop-blur-sm sm:items-center" role="dialog" aria-modal="true" aria-label="Private AI">
          <section className="max-h-[90svh] w-full max-w-md overflow-y-auto rounded-t-3xl border bg-card p-5 shadow-xl sm:rounded-3xl">
            <header className="mb-3 flex items-start justify-between gap-3">
              <h2 className="font-heading text-lg font-semibold">Inti's brain runs in private hardware</h2>
              <Button variant="ghost" size="icon" aria-label="Close" onClick={() => setOpen(false)}>
                <X />
              </Button>
            </header>
            <p className="text-sm text-muted-foreground">
              Inti's AI model runs inside a sealed chip (Intel TDX with an NVIDIA GPU), so the cloud that hosts the model cannot read what it works on. Inti's own server still
              sees your messages, to pass them to the model. Inti checks the chip with a new challenge each time, against Intel's and NVIDIA's own services.
            </p>
            {result && (
              <ul className="mt-4 flex flex-col gap-2 text-sm">
                {result.checks.map((c) => (
                  <li key={c.id} className="flex items-start gap-2">
                    {c.ok ? <Check className="mt-0.5 size-4 shrink-0 text-primary" /> : <X className="mt-0.5 size-4 shrink-0 text-destructive" />}
                    <span>{CHECK_TEXT[c.id]}</span>
                  </li>
                ))}
              </ul>
            )}
            {error && <p className="mt-4 text-sm text-destructive">{error}</p>}
            <div className="mt-4 flex items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">{result ? `Checked ${ago(result.checkedAt, now)}` : "Not checked yet"}</p>
              <Button className="rounded-full" disabled={checking} onClick={() => void check()}>
                {checking ? <Loader2 className="animate-spin" /> : <ShieldCheck />} Verify again
              </Button>
            </div>
            {result && (
              <details className="mt-4 rounded-2xl bg-muted px-3 py-2 text-xs">
                <summary className="cursor-pointer font-medium">Technical details</summary>
                <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 break-all">
                  <dt className="text-muted-foreground">Model</dt>
                  <dd>{result.model}</dd>
                  <dt className="text-muted-foreground">Signing key</dt>
                  <dd>
                    <code>{result.signingAddress ?? "--"}</code>
                  </dd>
                  <dt className="text-muted-foreground">Intel status</dt>
                  <dd>{result.intelStatus ?? "--"}</dd>
                  <dt className="text-muted-foreground">Checked at</dt>
                  <dd>{result.checkedAt}</dd>
                </dl>
              </details>
            )}
            <p className="mt-4 text-xs text-muted-foreground">
              This proves where the model runs. It does not yet prove that each reply came from this chip.
            </p>
          </section>
        </div>
      )}
    </>
  );
}
