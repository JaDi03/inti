import { useMfaEnrollment, usePrivy } from "@privy-io/react-auth";
import { Fingerprint, Loader2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";

/** True once the user has a passkey. Privy then asks for it before the wallet signs. */
export function useHasPasskey(): boolean {
  const { user } = usePrivy();
  return (user?.mfaMethods ?? []).includes("passkey");
}

/**
 * Asks the user to add a passkey. Once enrolled, Privy requires it before the wallet signs,
 * so code running in the page alone cannot sign. Inti does not sign without one.
 */
export function PasskeyProtection() {
  const hasPasskey = useHasPasskey();
  const { initEnrollmentWithPasskey } = useMfaEnrollment();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (hasPasskey) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Fingerprint className="size-4 text-primary" /> Every signature asks for your passkey.
      </p>
    );
  }

  const enroll = async () => {
    setBusy(true);
    setError(null);
    try {
      await initEnrollmentWithPasskey();
    } catch {
      setError("The passkey was not added. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-dashed p-3 text-sm">
      <p>Add a passkey so every signature asks for your fingerprint, face or security key. Inti does not sign without it.</p>
      <Button className="mt-2" size="sm" disabled={busy} onClick={() => void enroll()}>
        {busy ? <Loader2 className="animate-spin" /> : <Fingerprint />} Add a passkey
      </Button>
      {error && <p className="mt-2 text-destructive">{error}</p>}
    </div>
  );
}
