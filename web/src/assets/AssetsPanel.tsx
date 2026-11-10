import { Check, Coins, ExternalLink, Loader2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { ASSET_KEYS, ASSETS, type AssetKey } from "../../../agent/policy/assets";
import { fromAtomic } from "../../../agent/policy/units";
import { LimitsClient } from "../limits/client";
import { useOwnerSigner } from "../limits/ConfirmSigning";
import { loadLimitsConfig, type LimitsConfig } from "../limits/config";

/** Decimals of each asset's token on NEAR, as GET /v1/tokens lists them. */
const DECIMALS: Record<AssetKey, number> = { gold: 6, euro: 18, pound: 18, bitcoin: 8 };

interface Props {
  address: string;
  onClose: () => void;
}

type Row = { key: AssetKey; enabled: boolean; balance: bigint };

/**
 * What Inti can buy for the user. Each asset is enabled once: the user's wallet registers with its
 * token (a small one-time fee) so purchases can be delivered there. Inti never buys one that is off.
 */
export function AssetsPanel({ address, onClose }: Props) {
  const setup = useMemo(() => {
    try {
      const config = loadLimitsConfig(null);
      return { config, client: new LimitsClient(config) };
    } catch {
      return null;
    }
  }, []);
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-background/70 backdrop-blur-sm sm:items-center" role="dialog" aria-modal="true" aria-label="Assets">
      <section className="max-h-[92svh] w-full max-w-md overflow-y-auto rounded-t-3xl border bg-card p-5 shadow-xl sm:rounded-3xl">
        <header className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Coins className="size-5 text-primary" />
            <h2 className="text-lg font-semibold">Assets</h2>
          </div>
          <Button variant="ghost" size="icon" aria-label="Close" onClick={onClose}>
            <X />
          </Button>
        </header>
        <p className="mb-4 text-sm text-muted-foreground">
          What Inti can buy for you. Enable an asset once so your wallet can receive it. Inti never buys an asset you have not enabled.
        </p>
        {setup ? <AssetList address={address} config={setup.config} client={setup.client} /> : <p className="text-sm text-destructive">Inti is not available right now. Please try again later.</p>}
      </section>
    </div>
  );
}

function AssetList({ address, config, client }: { address: string; config: LimitsConfig; client: LimitsClient }) {
  const setup = { config, client };
  const { signer, confirmDialog } = useOwnerSigner(address, config);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [busy, setBusy] = useState<AssetKey | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastTx, setLastTx] = useState<string | null>(null);

  const read = useCallback(async () => {
    try {
      setRows(await client.assets(address));
    } catch {
      setError("Could not read your wallet. Try again in a minute.");
    }
  }, [client, address]);

  useEffect(() => {
    void read();
  }, [read]);

  const enable = async (key: AssetKey) => {
    setBusy(key);
    setError(null);
    try {
      setLastTx(await setup.client.enableAsset(address, signer, key));
      await read();
    } catch (e) {
      setError(e instanceof Error ? e.message : `${ASSETS[key].name} could not be enabled.`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
        {!rows && !error && <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" />}

        {rows && (
          <ul className="flex flex-col gap-2">
            {ASSET_KEYS.map((key) => {
              const row = rows.find((r) => r.key === key);
              const a = ASSETS[key];
              return (
                <li key={key} className="flex min-h-14 items-center justify-between gap-3 rounded-xl border border-border bg-background/60 px-4 py-2 text-sm">
                  <div className="min-w-0">
                    <p className="font-medium">
                      {a.name} <span className="text-muted-foreground">({a.symbol})</span>
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {a.kind === "real-world" ? "Real-world asset" : "Crypto"}
                      {row?.enabled ? ` · In your wallet: ${fromAtomic(row.balance.toString(), DECIMALS[key])}` : ""}
                    </p>
                  </div>
                  {row?.enabled ? (
                    <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-primary">
                      <Check className="size-4" /> Enabled
                    </span>
                  ) : (
                    <Button size="sm" className="shrink-0 rounded-xl" disabled={busy !== null} onClick={() => void enable(key)}>
                      {busy === key ? <Loader2 className="animate-spin" /> : null} Enable
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {rows && <p className="mt-3 text-xs text-muted-foreground">Enabling costs a one-time fee of about 0.00125 NEAR per asset, paid to the asset's token.</p>}
        {error && <p className="mt-3 break-words text-sm text-destructive">{error}</p>}
        {lastTx && (
          <a className="mt-3 inline-flex items-center gap-1 text-sm text-primary underline-offset-4 hover:underline" href={setup.config.explorerTxUrl(lastTx)} target="_blank" rel="noreferrer">
            View transaction <ExternalLink className="size-3.5" />
          </a>
        )}
        {confirmDialog}
    </>
  );
}
