import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** A NEAR account shown in full (or its two ends when `short`), with a button that copies all of it. */
export function AddressLine({ address, label, className, short = false }: { address: string; label: string; className?: string; short?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = () =>
    void navigator.clipboard.writeText(address).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      },
      () => undefined,
    );
  return (
    <div className={cn("flex items-start gap-1", className)}>
      <span className="min-w-0 flex-1 break-all font-mono text-xs text-muted-foreground" title={short ? address : undefined}>
        {short && address.length > 16 ? `${address.slice(0, 6)}…${address.slice(-6)}` : address}
      </span>
      <Button variant="ghost" size="icon-sm" className="-mt-1 shrink-0" aria-label={copied ? `${label} copied` : `Copy ${label}`} onClick={copy}>
        {copied ? <Check className="text-primary" /> : <Copy />}
      </Button>
    </div>
  );
}
