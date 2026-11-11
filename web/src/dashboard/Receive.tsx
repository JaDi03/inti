import { Check, Copy, X } from "lucide-react";
import { useMemo, useState } from "react";
import { encode } from "uqr";
import { Button } from "@/components/ui/button";

/**
 * QR code drawn as one SVG path from the encoded matrix, so no generated markup is
 * injected into the page. Always dark on white: phone cameras need that contrast,
 * also in dark mode.
 */
function QrCode({ value, size = 208, label }: { value: string; size?: number; label: string }) {
  const { path, modules } = useMemo(() => {
    const qr = encode(value, { ecc: "M", border: 2 });
    let d = "";
    qr.data.forEach((row, y) => row.forEach((dark, x) => dark && (d += `M${x} ${y}h1v1h-1z`)));
    return { path: d, modules: qr.size };
  }, [value]);
  return (
    <svg role="img" aria-label={label} width={size} height={size} viewBox={`0 0 ${modules} ${modules}`} shapeRendering="crispEdges" className="rounded-xl">
      <rect width={modules} height={modules} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}

/** The user's NEAR address to receive NEAR from another wallet or an exchange, as a QR and as text. */
export function ReceiveDialog({ address, onClose }: { address: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = () =>
    void navigator.clipboard.writeText(address).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => undefined,
    );

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-background/70 backdrop-blur-sm sm:items-center" role="dialog" aria-modal="true" aria-label="Receive NEAR">
      <section className="w-full max-w-sm rounded-t-3xl border bg-card p-5 shadow-xl sm:rounded-3xl">
        <header className="mb-4 flex items-center justify-between">
          <h2 className="font-heading text-lg font-semibold">Receive NEAR</h2>
          <Button variant="ghost" size="icon" aria-label="Close" onClick={onClose}>
            <X />
          </Button>
        </header>
        <div className="flex justify-center">
          <QrCode value={address} label="QR code of your NEAR address" />
        </div>
        <p className="mt-4 text-sm text-muted-foreground">Your NEAR address</p>
        <div className="mt-1.5 flex items-center gap-2 rounded-2xl bg-muted px-3 py-2">
          <code className="min-w-0 flex-1 break-all text-xs">{address}</code>
          <Button variant="ghost" size="icon-sm" aria-label={copied ? "Address copied" : "Copy address"} onClick={copy}>
            {copied ? <Check className="text-primary" /> : <Copy />}
          </Button>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Send NEAR on the NEAR network only, from another wallet or an exchange. Coins sent from other networks to this address can be lost.
        </p>
        <Button className="mt-4 w-full rounded-full" onClick={copy}>
          {copied ? <Check /> : <Copy />} {copied ? "Copied" : "Copy address"}
        </Button>
      </section>
    </div>
  );
}
