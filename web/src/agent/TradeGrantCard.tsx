import { Check, Loader2, Sparkles, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useOwnerSigner } from "../limits/ConfirmSigning";
import type { LimitsConfig } from "../limits/config";
import { grantState, issueGrant } from "./grant";

interface Props {
  address: string;
  config: LimitsConfig;
  getAccessToken: () => Promise<string | null>;
}

/**
 * Asks once for the user's permission to let Inti trade on its own, inside the limits already
 * signed. Hidden while the user has no agent and once a grant is live.
 */
export function TradeGrantCard({ address, config, getAccessToken }: Props) {
  const { signer, confirmDialog } = useOwnerSigner(address, config);
  const [needed, setNeeded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [until, setUntil] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    void (async () => {
      try {
        const token = await getAccessToken();
        const state = token ? await grantState(token) : null;
        if (current) setNeeded(state?.status === "active" && state.grant === null && state.agentAccount === config.agentAccount);
      } catch {
        // Without an answer the card stays hidden; the chat keeps working in practice mode.
      }
    })();
    return () => {
      current = false;
    };
  }, [getAccessToken, config.agentAccount]);

  if (!needed && until === null) return null;

  const allow = async () => {
    setBusy(true);
    setError(null);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error("Your session expired. Sign in again and retry.");
      setUntil(await issueGrant({ accessToken: token, accountId: address, signer }));
      setNeeded(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Inti could not be allowed to trade.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="w-full max-w-[560px] rounded-3xl border border-border bg-card p-5 text-left shadow-sm sm:p-6">
      <header className="mb-4 flex items-start gap-4">
        <span className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-muted">
          <Sparkles className="size-6 text-primary" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold leading-tight">{until ? "Inti can trade for you" : "Let Inti trade for you"}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {until
              ? `Until ${until.slice(0, 10)}. Ask it to buy in the chat; it will not ask you to sign each order.`
              : "One signature, valid for 90 days. After it, Inti buys what you ask without asking you to sign each order."}
          </p>
        </div>
      </header>
      {!until && (
        <>
          <ul className="mb-4 grid gap-1.5 text-sm">
            <li className="flex gap-2">
              <Check className="mt-0.5 size-4 shrink-0 text-primary" /> Buy only within the spending limits you set
            </li>
            <li className="flex gap-2">
              <Check className="mt-0.5 size-4 shrink-0 text-primary" /> Everything it buys goes straight to your wallet
            </li>
            <li className="flex gap-2">
              <X className="mt-0.5 size-4 shrink-0 text-muted-foreground" /> Send money to anyone else
            </li>
          </ul>
          <Button className="rounded-xl" disabled={busy} onClick={() => void allow()}>
            {busy ? <Loader2 className="animate-spin" /> : null} Let Inti trade
          </Button>
        </>
      )}
      {error && <p className="mt-3 break-words text-sm text-destructive">{error}</p>}
      {confirmDialog}
    </section>
  );
}
