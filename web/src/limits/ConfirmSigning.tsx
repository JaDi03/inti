import { useSignRawHash } from "@privy-io/react-auth/extended-chains";
import { ShieldCheck } from "lucide-react";
import { Dialog } from "radix-ui";
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { PrivyNearSigner } from "../privySigner";
import type { LimitsConfig } from "./config";
import { OwnerSigner } from "./ownerSigner";

type Pending = { lines: string[]; resolve: (ok: boolean) => void };

/**
 * The signer for the user's own account, plus the dialog it opens: every signature with the
 * account key first shows what it does in plain words and waits for the user to confirm.
 */
export function useOwnerSigner(address: string, config: LimitsConfig): { signer: OwnerSigner; confirmDialog: ReactNode } {
  const { signRawHash } = useSignRawHash();
  const [pending, setPending] = useState<Pending | null>(null);
  const pendingRef = useRef<Pending | null>(null);

  const confirm = useCallback(
    (lines: string[]) =>
      new Promise<boolean>((resolve) => {
        const next = { lines, resolve };
        pendingRef.current = next;
        setPending(next);
      }),
    [],
  );

  const answer = useCallback((ok: boolean) => {
    pendingRef.current?.resolve(ok);
    pendingRef.current = null;
    setPending(null);
  }, []);

  const signer = useMemo(() => new OwnerSigner(new PrivyNearSigner(address, signRawHash), config, confirm), [address, signRawHash, config, confirm]);

  const confirmDialog = (
    <Dialog.Root open={pending !== null} onOpenChange={(open) => !open && answer(false)}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-card p-5 text-card-foreground shadow-xl">
          <Dialog.Title className="flex items-center gap-2 text-lg font-semibold">
            <ShieldCheck className="size-5 text-primary" /> Confirm with your account
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-muted-foreground">This signature will:</Dialog.Description>
          <ul className="mt-3 flex list-disc flex-col gap-1.5 pl-5 text-sm">
            {pending?.lines.map((line) => <li key={line}>{line}</li>)}
          </ul>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="outline" onClick={() => answer(false)}>
              Cancel
            </Button>
            <Button onClick={() => answer(true)}>Confirm and sign</Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );

  return { signer, confirmDialog };
}
